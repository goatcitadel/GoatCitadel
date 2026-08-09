/* eslint-disable max-lines -- Postgres migration ledger keeps every versioned migration in one append-only file so ordering, dependencies, and rollback context stay traceable. */
import { buildPostgresRuntimeSchemaSql } from "./runtime-schema.js";
import { GOVERNED_REMEDIATION_POSTGRES_SCHEMA_SQL } from "./governed-remediation-schema.js";
import { GOVERNED_REMEDIATION_RECIPE_BINDING_POSTGRES_SQL } from "./governed-remediation-recipe-binding.js";
import { REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_POSTGRES_SQL } from "./remote-worker-protected-admission-evidence.js";
import { REMOTE_WORKER_MESH_NODE_ADMISSION_POSTGRES_SQL } from "./remote-worker-mesh-node-admission.js";
import { MOBILE_PUSH_POSTGRES_SCHEMA_SQL } from "./mobile-push-schema.js";

export interface PostgresMigration {
  version: number;
  name: string;
  sql: string;
  batchedStatements?: readonly PostgresMigrationBatchStatement[];
  /** Fail-closed digest for generated/batched SQL that source-only proof cannot reconstruct. */
  integritySha256?: string;
}

export interface PostgresMigrationBatchStatement {
  name: string;
  /**
   * A single bounded DML statement. The migrator repeats the ordered statement
   * list until a complete pass changes no rows, committing each statement in
   * its own transaction so an interrupted data migration can resume safely.
   */
  sql: string;
}

// FROZEN 2026-06-23: snapshot of buildPostgresRuntimeSchemaSql() captured at the time the
// v7 migration was retro-frozen. v7 (canonical_runtime_schema_repairs) is a HISTORICAL
// migration and MUST NOT change as the canonical runtime schema evolves; embedding the live
// function let every future schema edit silently mutate this already-authored migration,
// violating the migration-immutability contract. The string is stored as a JSON-escaped
// literal so its bytes (LF newlines, embedded quotes) stay identical to the function output
// regardless of source-file line endings. Do not edit this string; author a NEW migration
// for any schema change.
const POSTGRES_V7_FROZEN_SCHEMA_SQL =
  "CREATE TABLE IF NOT EXISTS a2a_task_bindings (\n  a2a_task_id TEXT PRIMARY KEY,\n  context_id TEXT NOT NULL,\n  peer_id TEXT NOT NULL,\n  workspace_id TEXT NOT NULL DEFAULT 'default',\n  session_id TEXT,\n  local_task_id TEXT,\n  durable_run_id TEXT,\n  state TEXT NOT NULL,\n  last_event_sequence BIGINT NOT NULL DEFAULT 0,\n  idempotency_key TEXT NOT NULL,\n  metadata_json TEXT NOT NULL DEFAULT '{}',\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS a2a_task_push_configs (\n  a2a_task_id TEXT NOT NULL,\n  peer_id TEXT NOT NULL,\n  url TEXT NOT NULL,\n  events_json TEXT NOT NULL DEFAULT '[\"task.status\"]',\n  enabled BIGINT NOT NULL DEFAULT 1,\n  auth_token TEXT,\n  max_attempts BIGINT NOT NULL DEFAULT 3,\n  attempt_count BIGINT NOT NULL DEFAULT 0,\n  last_delivery_status TEXT NOT NULL DEFAULT 'pending',\n  last_delivery_error TEXT,\n  last_delivered_at TEXT,\n  next_retry_at TEXT,\n  last_event_sequence BIGINT NOT NULL DEFAULT 0,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  PRIMARY KEY (a2a_task_id, peer_id)\n);\nCREATE TABLE IF NOT EXISTS agent_commitments (\n  commitment_id TEXT PRIMARY KEY,\n  session_id TEXT NOT NULL,\n  workspace_id TEXT NOT NULL DEFAULT 'default',\n  kind TEXT NOT NULL,\n  due_at TEXT NOT NULL,\n  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,\n  dedupe_key TEXT NOT NULL,\n  suggested_text TEXT NOT NULL,\n  status TEXT NOT NULL DEFAULT 'pending',\n  created_by TEXT NOT NULL DEFAULT 'classifier',\n  created_at TEXT NOT NULL,\n  sent_at TEXT\n);\nCREATE TABLE IF NOT EXISTS agent_profiles (\n  agent_id TEXT PRIMARY KEY,\n  role_id TEXT NOT NULL,\n  name TEXT NOT NULL,\n  title TEXT NOT NULL,\n  summary TEXT NOT NULL,\n  specialties_json TEXT NOT NULL,\n  default_tools_json TEXT NOT NULL,\n  aliases_json TEXT NOT NULL,\n  preset_defaults_json TEXT,\n  is_builtin BIGINT NOT NULL,\n  lifecycle_status TEXT NOT NULL DEFAULT 'active',\n  archived_at TEXT,\n  archived_by TEXT,\n  archive_reason TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS approval_events (\n  event_id TEXT PRIMARY KEY,\n  approval_id TEXT NOT NULL,\n  event_type TEXT NOT NULL,\n  actor_id TEXT NOT NULL,\n  timestamp TEXT NOT NULL,\n  payload_json TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS approval_inbox_items (\n  inbox_item_id TEXT PRIMARY KEY,\n  approval_id TEXT NOT NULL,\n  connector_id TEXT NOT NULL,\n  receiver_kind TEXT NOT NULL,\n  receiver_id TEXT NOT NULL,\n  token_id TEXT NOT NULL,\n  token TEXT NOT NULL,\n  action_type TEXT NOT NULL,\n  state TEXT NOT NULL DEFAULT 'pending',\n  approval_kind TEXT NOT NULL,\n  risk_level TEXT NOT NULL,\n  approval_status TEXT NOT NULL,\n  preview_json TEXT NOT NULL DEFAULT '{}',\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  expires_at TEXT NOT NULL,\n  resolved_at TEXT,\n  resolved_by TEXT,\n  last_error TEXT,\n  delivery_count BIGINT NOT NULL DEFAULT 1,\n  last_delivered_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS approvals (\n  approval_id TEXT PRIMARY KEY,\n  kind TEXT NOT NULL,\n  risk_level TEXT NOT NULL,\n  status TEXT NOT NULL,\n  linkage_json TEXT,\n  payload_json TEXT NOT NULL,\n  preview_json TEXT NOT NULL,\n  explanation_status TEXT NOT NULL DEFAULT 'not_requested',\n  explanation_json TEXT,\n  explanation_error TEXT,\n  explanation_updated_at TEXT,\n  created_at TEXT NOT NULL,\n  expires_at TEXT,\n  resolved_at TEXT,\n  resolved_by TEXT,\n  resolution_note TEXT,\n  shell_explanations_json TEXT\n);\nCREATE TABLE IF NOT EXISTS assembly_reputation (\n  model_ref TEXT PRIMARY KEY,\n  provider_id TEXT NOT NULL,\n  model_id TEXT NOT NULL,\n  overall DOUBLE PRECISION NOT NULL,\n  by_domain_json TEXT NOT NULL,\n  accuracy DOUBLE PRECISION NOT NULL,\n  reasoning_strength DOUBLE PRECISION NOT NULL,\n  critique_quality DOUBLE PRECISION NOT NULL,\n  consensus_leadership DOUBLE PRECISION NOT NULL,\n  stability DOUBLE PRECISION NOT NULL,\n  adversarial_usefulness DOUBLE PRECISION NOT NULL,\n  sample_count BIGINT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS assembly_runs (\n  run_id TEXT PRIMARY KEY,\n  workspace_id TEXT,\n  source_session_id TEXT,\n  source_task_id TEXT,\n  title TEXT NOT NULL,\n  status TEXT NOT NULL,\n  current_stage TEXT NOT NULL,\n  current_round_index BIGINT NOT NULL DEFAULT 0,\n  problem_json TEXT NOT NULL,\n  settings_json TEXT NOT NULL,\n  adversarial_settings_json TEXT NOT NULL,\n  result_json TEXT,\n  stop_reason TEXT,\n  usage_json TEXT,\n  error_text TEXT,\n  created_at TEXT NOT NULL,\n  started_at TEXT,\n  finished_at TEXT,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS auth_device_requests (\n  request_id TEXT PRIMARY KEY,\n  approval_id TEXT NOT NULL,\n  request_secret_hash TEXT NOT NULL,\n  device_label TEXT NOT NULL,\n  device_type TEXT NOT NULL,\n  platform TEXT,\n  requested_origin TEXT,\n  requested_ip TEXT,\n  user_agent TEXT,\n  status TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  expires_at TEXT NOT NULL,\n  resolved_at TEXT,\n  resolved_by TEXT,\n  resolution_note TEXT,\n  approved_token_plaintext TEXT,\n  approved_token_expires_at TEXT,\n  delivered_at TEXT\n);\nCREATE TABLE IF NOT EXISTS autonomy_audit (\n  audit_id TEXT PRIMARY KEY,\n  kind TEXT NOT NULL,\n  target_key TEXT NOT NULL DEFAULT '',\n  occurred_at TEXT NOT NULL,\n  restore_ref_json TEXT NOT NULL DEFAULT '{}',\n  reverted BIGINT NOT NULL DEFAULT 0,\n  reverted_at TEXT\n);\nCREATE TABLE IF NOT EXISTS candidate_skill_versions (\n  version_id TEXT PRIMARY KEY,\n  candidate_id TEXT NOT NULL,\n  source_kind TEXT NOT NULL,\n  title TEXT NOT NULL,\n  summary TEXT,\n  bundle_root TEXT NOT NULL,\n  originating_run_id TEXT,\n  wrapper_manifest_hash TEXT,\n  lifecycle_state TEXT NOT NULL,\n  manifest_artifact_json TEXT NOT NULL,\n  instruction_artifact_json TEXT NOT NULL,\n  proof_artifact_json TEXT NOT NULL,\n  program_artifact_json TEXT,\n  schema_artifact_json TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  last_successful_execution_at TEXT\n);\nCREATE TABLE IF NOT EXISTS capability_catalog_snapshots (\n  snapshot_id TEXT PRIMARY KEY,\n  inspectable_json TEXT NOT NULL,\n  callable_json TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS capability_proposals (\n  proposal_id TEXT PRIMARY KEY,\n  proposal_kind TEXT NOT NULL,\n  status TEXT NOT NULL,\n  title TEXT NOT NULL,\n  summary TEXT NOT NULL,\n  candidate_id TEXT,\n  activation_target_id TEXT,\n  payload_json TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS channel_setup_drafts (\n  draft_id TEXT PRIMARY KEY,\n  catalog_id TEXT NOT NULL,\n  connection_id TEXT,\n  lifecycle_mode TEXT NOT NULL,\n  label TEXT,\n  enabled BIGINT NOT NULL DEFAULT 1,\n  draft_json TEXT NOT NULL,\n  hydration_json TEXT,\n  content_version TEXT NOT NULL,\n  adapter_version TEXT NOT NULL,\n  validation_version TEXT NOT NULL,\n  test_version TEXT NOT NULL,\n  last_validated_at TEXT,\n  last_tested_at TEXT,\n  last_failure_category TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS chat_conversation_summaries (\n  summary_id TEXT PRIMARY KEY,\n  session_id TEXT NOT NULL,\n  branch_head_turn_id TEXT NOT NULL,\n  start_turn_id TEXT NOT NULL,\n  end_turn_id TEXT NOT NULL,\n  turn_ids_json TEXT NOT NULL,\n  source_hash TEXT NOT NULL,\n  token_estimate BIGINT NOT NULL,\n  summary_text TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS chat_delegation_runs (\n  run_id TEXT PRIMARY KEY,\n  parent_run_id TEXT,\n  session_id TEXT NOT NULL,\n  task_id TEXT NOT NULL,\n  objective TEXT NOT NULL,\n  roles_json TEXT NOT NULL,\n  mode TEXT NOT NULL,\n  provider_id TEXT,\n  model TEXT,\n  status TEXT NOT NULL,\n  visibility TEXT,\n  workflow_template TEXT,\n  route_decision_json TEXT,\n  final_summary TEXT,\n  stitched_output TEXT,\n  citations_json TEXT NOT NULL,\n  trace_json TEXT,\n  started_at TEXT NOT NULL,\n  finished_at TEXT,\n  execution_plan_id TEXT\n);\nCREATE TABLE IF NOT EXISTS chat_delegation_steps (\n  step_id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  role TEXT NOT NULL,\n  label TEXT,\n  step_index BIGINT NOT NULL,\n  status TEXT NOT NULL,\n  provider_id TEXT,\n  model TEXT,\n  summary TEXT,\n  output TEXT,\n  error TEXT,\n  failure_guidance TEXT,\n  durable_run_id TEXT,\n  child_session_id TEXT,\n  child_turn_id TEXT,\n  citations_json TEXT,\n  degraded_handoff_step_ids_json TEXT,\n  started_at TEXT NOT NULL,\n  finished_at TEXT,\n  duration_ms BIGINT\n);\nCREATE TABLE IF NOT EXISTS chat_execution_plan_steps (\n  plan_id TEXT NOT NULL,\n  step_id TEXT PRIMARY KEY,\n  step_index BIGINT NOT NULL,\n  objective TEXT NOT NULL,\n  success_criteria TEXT,\n  suggested_tools_json TEXT,\n  expected_output TEXT,\n  parallelizable BIGINT NOT NULL DEFAULT 0,\n  depends_on_step_ids_json TEXT,\n  delegated_role TEXT,\n  status TEXT NOT NULL,\n  summary TEXT,\n  error TEXT,\n  started_at TEXT,\n  finished_at TEXT,\n  child_run_id TEXT,\n  durable_run_id TEXT,\n  child_session_id TEXT,\n  child_turn_id TEXT\n);\nCREATE TABLE IF NOT EXISTS chat_execution_plans (\n  plan_id TEXT PRIMARY KEY,\n  session_id TEXT NOT NULL,\n  turn_id TEXT NOT NULL,\n  mode TEXT NOT NULL,\n  planning_mode TEXT NOT NULL,\n  status TEXT NOT NULL,\n  source TEXT NOT NULL,\n  advisory_only BIGINT NOT NULL DEFAULT 0,\n  objective TEXT NOT NULL,\n  summary TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  started_at TEXT,\n  finished_at TEXT\n);\nCREATE TABLE IF NOT EXISTS chat_generated_artifacts (\n  artifact_id TEXT PRIMARY KEY,\n  session_id TEXT NOT NULL,\n  workspace_id TEXT,\n  project_id TEXT,\n  turn_id TEXT NOT NULL,\n  title TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  content TEXT NOT NULL,\n  language TEXT,\n  source_surface TEXT NOT NULL,\n  version BIGINT NOT NULL,\n  supersedes_artifact_id TEXT,\n  provider_id TEXT,\n  model TEXT,\n  source_block_index BIGINT,\n  content_hash TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS chat_inline_approvals (\n  approval_id TEXT PRIMARY KEY,\n  session_id TEXT NOT NULL,\n  turn_id TEXT NOT NULL,\n  tool_name TEXT,\n  status TEXT NOT NULL,\n  reason TEXT,\n  expires_at TEXT,\n  resolved_by TEXT,\n  created_at TEXT NOT NULL,\n  resolved_at TEXT,\n  kind TEXT,\n  risk_level TEXT,\n  details_json TEXT\n);\nCREATE TABLE IF NOT EXISTS chat_messages (\n  seq BIGSERIAL PRIMARY KEY,\n  message_id TEXT NOT NULL,\n  session_id TEXT NOT NULL,\n  role TEXT NOT NULL,\n  actor_type TEXT NOT NULL,\n  actor_id TEXT NOT NULL,\n  content TEXT NOT NULL,\n  parts_json TEXT,\n  attachments_json TEXT,\n  timestamp TEXT NOT NULL,\n  token_input BIGINT,\n  token_output BIGINT,\n  cost_usd DOUBLE PRECISION,\n  created_at TEXT NOT NULL,\n  steered BIGINT,\n  parent_delegation_step_id TEXT\n);\nCREATE TABLE IF NOT EXISTS chat_projects (\n  project_id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  description TEXT,\n  workspace_path TEXT NOT NULL,\n  color TEXT,\n  lifecycle_status TEXT NOT NULL DEFAULT 'active',\n  archived_at TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  workspace_id TEXT NOT NULL DEFAULT 'default'\n);\nCREATE TABLE IF NOT EXISTS chat_reflection_attempts (\n  attempt_id TEXT PRIMARY KEY,\n  turn_id TEXT NOT NULL,\n  session_id TEXT NOT NULL,\n  reason TEXT NOT NULL,\n  outcome TEXT NOT NULL,\n  attempt_count BIGINT NOT NULL DEFAULT 1,\n  strategy TEXT,\n  error TEXT,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS chat_session_bindings (\n  session_id TEXT PRIMARY KEY,\n  transport TEXT NOT NULL,\n  connection_id TEXT,\n  target_json TEXT,\n  writable BIGINT NOT NULL DEFAULT 1,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  workspace_id TEXT NOT NULL DEFAULT 'default'\n);\nCREATE TABLE IF NOT EXISTS chat_session_branch_state (\n  session_id TEXT PRIMARY KEY,\n  active_leaf_turn_id TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS chat_session_meta (\n  session_id TEXT PRIMARY KEY,\n  workspace_id TEXT NOT NULL DEFAULT 'default',\n  title TEXT,\n  origin TEXT,\n  include_in_history BIGINT NOT NULL DEFAULT 1,\n  pinned BIGINT NOT NULL DEFAULT 0,\n  lifecycle_status TEXT NOT NULL DEFAULT 'active',\n  archived_at TEXT,\n  folder_id TEXT,\n  folder_name TEXT,\n  tags_json TEXT NOT NULL DEFAULT '[]',\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  pinned_goal TEXT,\n  goal_turn_budget BIGINT,\n  goal_turns_used BIGINT NOT NULL DEFAULT 0,\n  goal_set_at TEXT\n);\nCREATE TABLE IF NOT EXISTS chat_session_prefs (\n  session_id TEXT PRIMARY KEY,\n  mode TEXT NOT NULL DEFAULT 'chat',\n  planning_mode TEXT NOT NULL DEFAULT 'off',\n  provider_id TEXT,\n  model TEXT,\n  image_provider_id TEXT,\n  image_model TEXT,\n  web_mode TEXT NOT NULL DEFAULT 'auto',\n  memory_mode TEXT NOT NULL DEFAULT 'auto',\n  thinking_level TEXT NOT NULL DEFAULT 'standard',\n  speed_mode TEXT NOT NULL DEFAULT 'standard',\n  subagent_policy TEXT NOT NULL DEFAULT 'ask_when_useful',\n  tool_autonomy TEXT NOT NULL DEFAULT 'safe_auto',\n  vision_fallback_model TEXT,\n  orchestration_enabled BIGINT NOT NULL DEFAULT 1,\n  orchestration_intensity TEXT NOT NULL DEFAULT 'balanced',\n  orchestration_visibility TEXT NOT NULL DEFAULT 'summarized',\n  orchestration_provider_preference TEXT NOT NULL DEFAULT 'balanced',\n  orchestration_review_depth TEXT NOT NULL DEFAULT 'standard',\n  orchestration_parallelism TEXT NOT NULL DEFAULT 'auto',\n  code_auto_apply TEXT NOT NULL DEFAULT 'aggressive_auto',\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS chat_specialist_candidates (\n  candidate_id TEXT PRIMARY KEY,\n  workspace_id TEXT,\n  session_id TEXT NOT NULL,\n  lead_turn_id TEXT,\n  lead_run_id TEXT,\n  title TEXT NOT NULL,\n  role TEXT NOT NULL,\n  summary TEXT NOT NULL,\n  reason TEXT NOT NULL,\n  source TEXT NOT NULL,\n  status TEXT NOT NULL,\n  routing_mode TEXT NOT NULL,\n  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,\n  requires_approval BIGINT NOT NULL DEFAULT 1,\n  suggested_tools_json TEXT,\n  suggested_skills_json TEXT,\n  routing_hints_json TEXT NOT NULL,\n  evidence_json TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  activated_at TEXT,\n  retired_at TEXT\n);\nCREATE TABLE IF NOT EXISTS chat_stream_events (\n  event_id TEXT PRIMARY KEY,\n  session_id TEXT NOT NULL,\n  turn_id TEXT NOT NULL,\n  sequence BIGINT NOT NULL,\n  run_id TEXT,\n  chunk_type TEXT NOT NULL,\n  payload_json TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS chat_thread_knowledge_attachments (\n  attachment_id TEXT PRIMARY KEY,\n  session_id TEXT NOT NULL,\n  source_type TEXT NOT NULL,\n  source_ref TEXT NOT NULL,\n  title TEXT NOT NULL,\n  retrieval_mode TEXT NOT NULL,\n  ingest_status TEXT NOT NULL,\n  chunk_count BIGINT,\n  namespace TEXT,\n  chat_attachment_id TEXT,\n  document_id TEXT,\n  error_message TEXT,\n  last_ingest_at TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS chat_tool_artifacts (\n  artifact_id TEXT PRIMARY KEY,\n  session_id TEXT NOT NULL,\n  turn_id TEXT NOT NULL,\n  tool_run_id TEXT NOT NULL,\n  tool_name TEXT NOT NULL,\n  content_type TEXT,\n  byte_length BIGINT NOT NULL,\n  snippet TEXT,\n  storage_rel_path TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS chat_tool_runs (\n  tool_run_id TEXT PRIMARY KEY,\n  turn_id TEXT NOT NULL,\n  session_id TEXT NOT NULL,\n  tool_name TEXT NOT NULL,\n  status TEXT NOT NULL,\n  approval_id TEXT,\n  args_json TEXT,\n  result_json TEXT,\n  reused BIGINT,\n  reused_from_tool_run_id TEXT,\n  reuse_reason TEXT,\n  error TEXT,\n  failure_guidance TEXT,\n  started_at TEXT NOT NULL,\n  finished_at TEXT\n);\nCREATE TABLE IF NOT EXISTS chat_turn_traces (\n  turn_id TEXT PRIMARY KEY,\n  session_id TEXT NOT NULL,\n  user_message_id TEXT NOT NULL,\n  assistant_message_id TEXT,\n  status TEXT NOT NULL,\n  mode TEXT NOT NULL,\n  model TEXT,\n  web_mode TEXT NOT NULL,\n  memory_mode TEXT NOT NULL,\n  thinking_level TEXT NOT NULL,\n  routing_json TEXT NOT NULL,\n  retrieval_json TEXT,\n  reflection_json TEXT,\n  proactive_json TEXT,\n  orchestration_json TEXT,\n  guidance_json TEXT,\n  loop_guard_json TEXT,\n  pending_user_input_json TEXT,\n  citations_json TEXT,\n  failure_json TEXT,\n  capability_upgrade_suggestions_json TEXT,\n  started_at TEXT NOT NULL,\n  finished_at TEXT,\n  parent_turn_id TEXT,\n  branch_kind TEXT NOT NULL DEFAULT 'append',\n  source_turn_id TEXT,\n  specialist_candidate_suggestions_json TEXT,\n  execution_plan_id TEXT,\n  completion_json TEXT,\n  durable_json TEXT\n);\nCREATE TABLE IF NOT EXISTS citadel_agent_assignments (\n  assignment_id TEXT PRIMARY KEY,\n  citadel_id TEXT NOT NULL,\n  agent_id TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS citadel_chambers (\n  chamber_id TEXT PRIMARY KEY,\n  citadel_id TEXT NOT NULL,\n  name TEXT NOT NULL,\n  sensitivity TEXT NOT NULL DEFAULT 'private',\n  sealed BIGINT NOT NULL DEFAULT 0,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS citadel_charters (\n  citadel_id TEXT PRIMARY KEY,\n  purpose TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  goals_json TEXT NOT NULL DEFAULT '[]',\n  boundaries_json TEXT NOT NULL DEFAULT '[]',\n  success_definition_json TEXT NOT NULL DEFAULT '[]',\n  default_chamber_id TEXT,\n  risk_posture TEXT NOT NULL DEFAULT 'balanced',\n  model_policy_default TEXT NOT NULL DEFAULT 'hybrid_guarded',\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS citadel_integration_grants (\n  grant_id TEXT PRIMARY KEY,\n  citadel_id TEXT NOT NULL,\n  provider TEXT NOT NULL,\n  account TEXT,\n  capabilities_json TEXT NOT NULL DEFAULT '[]',\n  mode TEXT NOT NULL DEFAULT 'read',\n  expires_at TEXT,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS citadel_members (\n  member_id TEXT PRIMARY KEY,\n  citadel_id TEXT NOT NULL,\n  subject_id TEXT NOT NULL,\n  role TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS citadel_passages (\n  passage_id TEXT PRIMARY KEY,\n  source_citadel_id TEXT NOT NULL,\n  source_chamber_id TEXT,\n  destination_citadel_id TEXT NOT NULL,\n  allowed_fields_json TEXT NOT NULL DEFAULT '[]',\n  expires_at TEXT,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS citadel_records (\n  citadel_id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  description TEXT,\n  slug TEXT NOT NULL,\n  kind TEXT NOT NULL DEFAULT 'custom',\n  lifecycle_status TEXT NOT NULL DEFAULT 'active',\n  archived_at TEXT,\n  default_workspace_id TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS citadel_vault_secrets (\n  secret_id TEXT PRIMARY KEY,\n  citadel_id TEXT NOT NULL,\n  secret_name TEXT NOT NULL,\n  sealed_value_json TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS citadel_wards (\n  ward_id TEXT PRIMARY KEY,\n  citadel_id TEXT NOT NULL,\n  name TEXT NOT NULL,\n  action_pattern TEXT NOT NULL,\n  effect TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS code_mode_runs (\n  run_id TEXT PRIMARY KEY,\n  status TEXT NOT NULL,\n  language TEXT NOT NULL,\n  origin_surface TEXT,\n  requested_output_intent TEXT,\n  save_candidate_on_success BIGINT NOT NULL DEFAULT 0,\n  capability_snapshot_id TEXT NOT NULL,\n  code_mode_input_hash TEXT,\n  wrapper_manifest_hash TEXT NOT NULL,\n  policy_snapshot_hash TEXT NOT NULL,\n  code_hash TEXT NOT NULL,\n  approval_id TEXT,\n  session_id TEXT,\n  turn_id TEXT,\n  execution_backend_json TEXT,\n  code_artifact_json TEXT NOT NULL,\n  wrapper_manifest_artifact_json TEXT NOT NULL,\n  policy_snapshot_artifact_json TEXT NOT NULL,\n  stdout_artifact_json TEXT,\n  stderr_artifact_json TEXT,\n  stdout_preview TEXT,\n  stderr_preview TEXT,\n  stdout_truncated BIGINT NOT NULL DEFAULT 0,\n  stderr_truncated BIGINT NOT NULL DEFAULT 0,\n  result_json TEXT,\n  error_text TEXT,\n  error_code TEXT,\n  error_details_json TEXT,\n  created_at TEXT NOT NULL,\n  started_at TEXT,\n  finished_at TEXT,\n  workspace_id TEXT,\n  operator_id TEXT,\n  permission_profile_id TEXT,\n  permission_profile_label TEXT,\n  local_operator_override_id TEXT,\n  sandbox_json TEXT\n);\nCREATE TABLE IF NOT EXISTS comms_deliveries (\n  delivery_id TEXT PRIMARY KEY,\n  connection_id TEXT NOT NULL,\n  channel_key TEXT NOT NULL,\n  target TEXT NOT NULL,\n  payload_hash TEXT NOT NULL,\n  payload_json TEXT,\n  status TEXT NOT NULL,\n  delivery_status TEXT,\n  idempotency_key TEXT,\n  attempts BIGINT NOT NULL DEFAULT 0,\n  max_attempts BIGINT NOT NULL DEFAULT 3,\n  next_attempt_at TEXT,\n  stale_after_ms BIGINT,\n  base_backoff_ms BIGINT,\n  max_backoff_ms BIGINT,\n  provider_msg_id TEXT,\n  error TEXT,\n  stale_reason TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS connector_health_runs (\n  health_run_id TEXT PRIMARY KEY,\n  connector_type TEXT NOT NULL,\n  connector_id TEXT NOT NULL,\n  status TEXT NOT NULL,\n  summary_json TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS context_manifests (\n  manifest_id TEXT PRIMARY KEY,\n  scope TEXT NOT NULL,\n  turn_id TEXT NOT NULL,\n  session_id TEXT,\n  task_id TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS cost_ledger (\n  ledger_id BIGSERIAL PRIMARY KEY,\n  session_id TEXT NOT NULL,\n  agent_id TEXT,\n  task_id TEXT,\n  provider_id TEXT,\n  model_id TEXT,\n  day TEXT NOT NULL,\n  token_input BIGINT NOT NULL DEFAULT 0,\n  token_output BIGINT NOT NULL DEFAULT 0,\n  token_cached_input BIGINT NOT NULL DEFAULT 0,\n  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,\n  created_at TEXT NOT NULL,\n  credential_type TEXT,\n  usage_pool TEXT\n);\nCREATE TABLE IF NOT EXISTS cron_jobs (\n  job_id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  action TEXT NOT NULL DEFAULT 'task',\n  action_config_json TEXT,\n  description TEXT,\n  schedule TEXT NOT NULL,\n  enabled BIGINT NOT NULL DEFAULT 1,\n  end_at TEXT,\n  last_run_at TEXT,\n  next_run_at TEXT,\n  workdir TEXT,\n  context_from TEXT,\n  last_run_output TEXT,\n  last_run_id TEXT,\n  citadel_id TEXT,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS cron_review_items (\n  item_id TEXT PRIMARY KEY,\n  job_id TEXT NOT NULL,\n  run_id TEXT NOT NULL,\n  severity TEXT NOT NULL,\n  status TEXT NOT NULL,\n  summary_json TEXT NOT NULL,\n  diff_json TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  resolved_at TEXT\n);\nCREATE TABLE IF NOT EXISTS cron_run_diffs (\n  diff_id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  previous_run_id TEXT,\n  diff_json TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS daemon_events (\n  event_id TEXT PRIMARY KEY,\n  event_type TEXT NOT NULL,\n  payload_json TEXT,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS decision_replay_dedup (\n  fingerprint TEXT PRIMARY KEY,\n  last_seen_report_id TEXT,\n  last_seen_at TEXT NOT NULL,\n  occurrence_count BIGINT NOT NULL DEFAULT 1,\n  last_summary_hash TEXT\n);\nCREATE TABLE IF NOT EXISTS decision_replay_runs (\n  run_id TEXT PRIMARY KEY,\n  trigger_mode TEXT NOT NULL,\n  sample_size BIGINT NOT NULL DEFAULT 500,\n  window_start TEXT NOT NULL,\n  window_end TEXT NOT NULL,\n  status TEXT NOT NULL,\n  report_id TEXT,\n  total_candidates BIGINT NOT NULL DEFAULT 0,\n  total_scored BIGINT NOT NULL DEFAULT 0,\n  likely_wrong_count BIGINT NOT NULL DEFAULT 0,\n  model_judged_count BIGINT NOT NULL DEFAULT 0,\n  error_text TEXT,\n  started_at TEXT NOT NULL,\n  finished_at TEXT\n);\nCREATE TABLE IF NOT EXISTS durable_runs (\n  run_id TEXT PRIMARY KEY,\n  workflow_key TEXT NOT NULL,\n  status TEXT NOT NULL,\n  attempt_count BIGINT NOT NULL DEFAULT 0,\n  max_attempts BIGINT NOT NULL DEFAULT 3,\n  payload_json TEXT NOT NULL,\n  metadata_json TEXT,\n  started_at TEXT,\n  finished_at TEXT,\n  last_error TEXT,\n  lease_owner_id TEXT,\n  lease_expires_at TEXT,\n  lease_heartbeat_at TEXT,\n  version BIGINT NOT NULL DEFAULT 1,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS external_connector_review_states (\n  workspace_id TEXT NOT NULL DEFAULT 'default',\n  source_id TEXT NOT NULL,\n  service_id TEXT NOT NULL,\n  action_id TEXT NOT NULL DEFAULT '',\n  status TEXT NOT NULL,\n  pinned BIGINT NOT NULL DEFAULT 0,\n  note TEXT,\n  proposal_id TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  PRIMARY KEY (workspace_id, source_id, service_id, action_id)\n);\nCREATE TABLE IF NOT EXISTS external_side_effect_runs (\n  run_id TEXT PRIMARY KEY,\n  workspace_id TEXT NOT NULL DEFAULT 'default',\n  boundary TEXT NOT NULL,\n  route_path TEXT NOT NULL,\n  catalog_id TEXT,\n  connection_id TEXT,\n  action_id TEXT,\n  actor_scope TEXT NOT NULL DEFAULT '',\n  idempotency_key TEXT NOT NULL,\n  payload_hash TEXT NOT NULL,\n  status TEXT NOT NULL,\n  replay_policy TEXT NOT NULL,\n  replay_outcome TEXT,\n  replay_attempt TEXT,\n  resume_state TEXT NOT NULL,\n  request_payload_json TEXT,\n  response_payload_json TEXT,\n  external_reference_id TEXT,\n  envelope_id TEXT,\n  error_text TEXT,\n  attempt_count BIGINT NOT NULL DEFAULT 0,\n  external_call_started_at TEXT,\n  completed_at TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS hook_runs (\n  run_id TEXT PRIMARY KEY,\n  hook_id TEXT NOT NULL,\n  workspace_id TEXT NOT NULL,\n  trigger TEXT NOT NULL,\n  entity_type TEXT NOT NULL,\n  entity_id TEXT NOT NULL,\n  mode TEXT NOT NULL,\n  status TEXT NOT NULL,\n  idempotency_key TEXT NOT NULL,\n  attempt_count BIGINT NOT NULL DEFAULT 0,\n  durable_run_id TEXT,\n  decision_json TEXT,\n  patch_summary_json TEXT,\n  error_text TEXT,\n  latency_ms BIGINT,\n  request_payload_json TEXT,\n  response_payload_json TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  completed_at TEXT\n);\nCREATE TABLE IF NOT EXISTS imported_agent_catalog (\n  entry_id TEXT PRIMARY KEY,\n  workspace_id TEXT NOT NULL,\n  division TEXT NOT NULL,\n  state TEXT NOT NULL,\n  definition_id TEXT NOT NULL,\n  slug TEXT NOT NULL,\n  frontmatter_json TEXT NOT NULL,\n  raw_markdown TEXT NOT NULL,\n  body_markdown TEXT NOT NULL,\n  section_order_json TEXT NOT NULL,\n  section_map_json TEXT NOT NULL,\n  parse_status TEXT NOT NULL,\n  parse_warnings_json TEXT NOT NULL,\n  provenance_provider TEXT NOT NULL,\n  provenance_repo_url TEXT,\n  provenance_ref TEXT,\n  provenance_commit TEXT,\n  provenance_path TEXT NOT NULL,\n  provenance_sha256 TEXT NOT NULL,\n  imported_at TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  activated_at TEXT,\n  retired_at TEXT,\n  search_text TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS improvement_candidates (\n  candidate_id TEXT PRIMARY KEY,\n  workspace_id TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  status TEXT NOT NULL,\n  target_key TEXT NOT NULL,\n  fingerprint TEXT NOT NULL,\n  summary TEXT NOT NULL,\n  current_revision_id TEXT,\n  supporting_signal_count BIGINT NOT NULL DEFAULT 0,\n  negative_signal_count BIGINT NOT NULL DEFAULT 0,\n  severity TEXT,\n  suppression_until TEXT,\n  latest_signal_at TEXT,\n  aggregate_json TEXT NOT NULL DEFAULT '{}',\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  created_by_actor_id TEXT,\n  created_by_actor_type TEXT,\n  updated_by_actor_id TEXT,\n  updated_by_actor_type TEXT\n);\nCREATE TABLE IF NOT EXISTS improvement_signals (\n  signal_id TEXT PRIMARY KEY,\n  schema_version TEXT NOT NULL,\n  source_service TEXT NOT NULL,\n  source_type TEXT NOT NULL,\n  source_id TEXT NOT NULL,\n  source_event_id TEXT NOT NULL,\n  idempotency_key TEXT NOT NULL,\n  workspace_id TEXT NOT NULL,\n  occurred_at TEXT NOT NULL,\n  recorded_at TEXT NOT NULL,\n  origin TEXT NOT NULL,\n  signal_class TEXT NOT NULL,\n  signal_kind TEXT NOT NULL,\n  outcome TEXT NOT NULL,\n  fingerprint TEXT NOT NULL,\n  session_id TEXT,\n  turn_id TEXT,\n  durable_run_id TEXT,\n  approval_id TEXT,\n  task_id TEXT,\n  tool_name TEXT,\n  capability_id TEXT,\n  memory_item_id TEXT,\n  severity TEXT,\n  cost_delta_usd DOUBLE PRECISION,\n  latency_delta_ms DOUBLE PRECISION,\n  score_delta DOUBLE PRECISION,\n  evidence_refs_json TEXT NOT NULL DEFAULT '[]',\n  metadata_json TEXT,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS inbound_events (\n  endpoint TEXT NOT NULL,\n  idempotency_key TEXT NOT NULL,\n  event_id TEXT NOT NULL,\n  session_key TEXT NOT NULL,\n  payload_hash TEXT NOT NULL,\n  received_at TEXT NOT NULL,\n  processed_at TEXT,\n  status TEXT NOT NULL,\n  PRIMARY KEY (endpoint, idempotency_key)\n);\nCREATE TABLE IF NOT EXISTS integration_connections (\n  connection_id TEXT PRIMARY KEY,\n  catalog_id TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  integration_key TEXT NOT NULL,\n  label TEXT NOT NULL,\n  enabled BIGINT NOT NULL DEFAULT 1,\n  status TEXT NOT NULL,\n  config_json TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  last_sync_at TEXT,\n  last_error TEXT,\n  plugin_id TEXT,\n  plugin_version TEXT,\n  plugin_enabled BIGINT NOT NULL DEFAULT 0,\n  plugin_meta_json TEXT\n);\nCREATE TABLE IF NOT EXISTS knowledge_documents (\n  doc_id TEXT PRIMARY KEY,\n  namespace TEXT NOT NULL,\n  source_type TEXT NOT NULL,\n  source_ref TEXT NOT NULL,\n  title TEXT NOT NULL,\n  metadata_json TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS learned_memory_conflicts (\n  conflict_id TEXT PRIMARY KEY,\n  session_id TEXT NOT NULL,\n  item_type TEXT NOT NULL,\n  existing_item_id TEXT,\n  incoming_item_id TEXT,\n  incoming_content TEXT NOT NULL,\n  status TEXT NOT NULL DEFAULT 'open',\n  resolution_note TEXT,\n  created_at TEXT NOT NULL,\n  resolved_at TEXT\n);\nCREATE TABLE IF NOT EXISTS learned_memory_items (\n  item_id TEXT PRIMARY KEY,\n  session_id TEXT NOT NULL,\n  item_type TEXT NOT NULL,\n  content TEXT NOT NULL,\n  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,\n  status TEXT NOT NULL DEFAULT 'active',\n  superseded_by_item_id TEXT,\n  redacted BIGINT NOT NULL DEFAULT 0,\n  disabled_reason TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS learned_memory_sources (\n  source_id TEXT PRIMARY KEY,\n  item_id TEXT NOT NULL,\n  source_kind TEXT NOT NULL,\n  source_ref TEXT NOT NULL,\n  snippet TEXT,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS llm_eval_proof_runs (\n  run_id TEXT PRIMARY KEY,\n  prompt_hash TEXT NOT NULL,\n  session_id TEXT,\n  task_id TEXT,\n  status TEXT NOT NULL,\n  candidates_json TEXT NOT NULL DEFAULT '[]',\n  results_json TEXT NOT NULL DEFAULT '[]',\n  warnings_json TEXT NOT NULL DEFAULT '[]',\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS llm_runtime_measurements (\n  measurement_id TEXT PRIMARY KEY,\n  provider_id TEXT NOT NULL,\n  model TEXT NOT NULL,\n  engine_kind TEXT NOT NULL,\n  source TEXT NOT NULL,\n  status TEXT NOT NULL,\n  stream BIGINT NOT NULL DEFAULT 0,\n  session_id TEXT,\n  task_id TEXT,\n  run_id TEXT,\n  metrics_json TEXT NOT NULL DEFAULT '{}',\n  provenance_json TEXT NOT NULL DEFAULT '{}',\n  error_text TEXT,\n  collected_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS local_operator_overrides (\n  override_id TEXT PRIMARY KEY,\n  operator_id TEXT NOT NULL,\n  scope TEXT NOT NULL,\n  scope_ref TEXT,\n  reason TEXT NOT NULL,\n  status TEXT NOT NULL,\n  created_by TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  expires_at TEXT NOT NULL,\n  revoked_at TEXT,\n  revoked_by TEXT\n);\nCREATE TABLE IF NOT EXISTS mason_sessions (\n  session_id TEXT PRIMARY KEY,\n  answers_json TEXT NOT NULL DEFAULT '{}',\n  status TEXT NOT NULL DEFAULT 'collecting',\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS mcp_servers (\n  server_id TEXT PRIMARY KEY,\n  label TEXT NOT NULL,\n  transport TEXT NOT NULL,\n  command TEXT,\n  args_json TEXT,\n  url TEXT,\n  auth_type TEXT NOT NULL DEFAULT 'none',\n  enabled BIGINT NOT NULL DEFAULT 1,\n  status TEXT NOT NULL DEFAULT 'disconnected',\n  last_error TEXT,\n  last_connected_at TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS media_jobs (\n  job_id TEXT PRIMARY KEY,\n  session_id TEXT,\n  attachment_id TEXT,\n  job_type TEXT NOT NULL,\n  status TEXT NOT NULL,\n  input_json TEXT,\n  output_json TEXT,\n  error TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  completed_at TEXT\n);\nCREATE TABLE IF NOT EXISTS memory_context_packs (\n  context_id TEXT PRIMARY KEY,\n  cache_key TEXT NOT NULL,\n  scope TEXT NOT NULL,\n  session_id TEXT,\n  task_id TEXT,\n  run_id TEXT,\n  phase_id TEXT,\n  query_hash TEXT NOT NULL,\n  sources_hash TEXT NOT NULL,\n  context_text TEXT NOT NULL,\n  citations_json TEXT NOT NULL,\n  quality_json TEXT NOT NULL,\n  original_token_estimate BIGINT NOT NULL,\n  distilled_token_estimate BIGINT NOT NULL,\n  created_at TEXT NOT NULL,\n  expires_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS memory_decisions (\n  decision_id TEXT PRIMARY KEY,\n  workspace_id TEXT NOT NULL,\n  scope TEXT NOT NULL,\n  title TEXT NOT NULL,\n  decision_text TEXT NOT NULL,\n  alternatives_json TEXT NOT NULL,\n  rationale TEXT NOT NULL,\n  expected_outcome TEXT,\n  review_at TEXT,\n  retrospective_json TEXT,\n  linked_entity_ids_json TEXT NOT NULL,\n  linked_relation_ids_json TEXT NOT NULL,\n  session_id TEXT,\n  run_id TEXT,\n  improvement_candidate_id TEXT,\n  status TEXT NOT NULL DEFAULT 'active',\n  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,\n  source_refs_json TEXT NOT NULL,\n  metadata_json TEXT NOT NULL,\n  authority TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  forgotten_at TEXT,\n  superseded_by_id TEXT\n);\nCREATE TABLE IF NOT EXISTS memory_entities (\n  entity_id TEXT PRIMARY KEY,\n  workspace_id TEXT NOT NULL,\n  scope TEXT NOT NULL,\n  title TEXT NOT NULL,\n  entity_type TEXT NOT NULL,\n  aliases_json TEXT NOT NULL,\n  summary TEXT,\n  status TEXT NOT NULL DEFAULT 'active',\n  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,\n  source_refs_json TEXT NOT NULL,\n  metadata_json TEXT NOT NULL,\n  authority TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  forgotten_at TEXT,\n  superseded_by_id TEXT\n);\nCREATE TABLE IF NOT EXISTS memory_items (\n  item_id TEXT PRIMARY KEY,\n  namespace TEXT NOT NULL,\n  title TEXT NOT NULL,\n  content TEXT NOT NULL,\n  metadata_json TEXT NOT NULL,\n  pinned BIGINT NOT NULL DEFAULT 0,\n  ttl_override_seconds BIGINT,\n  expires_at TEXT,\n  status TEXT NOT NULL DEFAULT 'active',\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  forgotten_at TEXT,\n  workspace_id TEXT\n);\nCREATE TABLE IF NOT EXISTS memory_maintenance_recommendations (\n  recommendation_id TEXT PRIMARY KEY,\n  workspace_id TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  status TEXT NOT NULL,\n  summary TEXT NOT NULL,\n  proposed_patch_json TEXT NOT NULL,\n  rationale TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  applied_at TEXT\n);\nCREATE TABLE IF NOT EXISTS memory_maintenance_runs (\n  run_id TEXT PRIMARY KEY,\n  durable_run_id TEXT,\n  workspace_id TEXT NOT NULL,\n  trigger_source TEXT NOT NULL,\n  status TEXT NOT NULL,\n  provider_id TEXT,\n  model TEXT,\n  policy_snapshot_json TEXT NOT NULL,\n  source_session_count BIGINT NOT NULL DEFAULT 0,\n  changed_artifact_count BIGINT NOT NULL DEFAULT 0,\n  summary TEXT,\n  error_text TEXT,\n  created_at TEXT NOT NULL,\n  started_at TEXT,\n  finished_at TEXT,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS memory_qmd_runs (\n  run_event_id TEXT PRIMARY KEY,\n  scope TEXT NOT NULL,\n  session_id TEXT,\n  task_id TEXT,\n  run_id TEXT,\n  phase_id TEXT,\n  status TEXT NOT NULL,\n  provider_id TEXT,\n  model TEXT,\n  duration_ms BIGINT NOT NULL,\n  candidate_count BIGINT NOT NULL,\n  citations_count BIGINT NOT NULL,\n  original_token_estimate BIGINT NOT NULL,\n  distilled_token_estimate BIGINT NOT NULL,\n  savings_percent DOUBLE PRECISION NOT NULL,\n  error_text TEXT,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS memory_quality_issues (\n  issue_id TEXT PRIMARY KEY,\n  workspace_id TEXT NOT NULL,\n  dedup_key TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  status TEXT NOT NULL,\n  severity TEXT NOT NULL,\n  target_kind TEXT NOT NULL,\n  target_ref TEXT NOT NULL,\n  related_refs_json TEXT NOT NULL DEFAULT '[]',\n  evidence_refs_json TEXT NOT NULL DEFAULT '[]',\n  summary TEXT NOT NULL,\n  rationale TEXT,\n  metadata_json TEXT NOT NULL DEFAULT '{}',\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  resolved_at TEXT,\n  resolution_note TEXT\n);\nCREATE TABLE IF NOT EXISTS memory_structured_change_history (\n  change_id TEXT PRIMARY KEY,\n  record_kind TEXT NOT NULL,\n  record_id TEXT NOT NULL,\n  change_type TEXT NOT NULL,\n  actor_id TEXT,\n  payload_json TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS mesh_join_tokens (\n  token_hash TEXT PRIMARY KEY,\n  created_at TEXT NOT NULL,\n  expires_at TEXT NOT NULL,\n  used_at TEXT,\n  used_by_node_id TEXT\n);\nCREATE TABLE IF NOT EXISTS mesh_leases (\n  lease_key TEXT PRIMARY KEY,\n  holder_node_id TEXT NOT NULL,\n  fencing_token BIGINT NOT NULL,\n  expires_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS mesh_nodes (\n  node_id TEXT PRIMARY KEY,\n  label TEXT,\n  advertise_address TEXT,\n  transport TEXT NOT NULL,\n  status TEXT NOT NULL,\n  capabilities_json TEXT NOT NULL,\n  tls_fingerprint TEXT,\n  joined_at TEXT NOT NULL,\n  last_seen_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS mesh_replication_log (\n  replication_id TEXT PRIMARY KEY,\n  source_node_id TEXT NOT NULL,\n  event_type TEXT NOT NULL,\n  payload_json TEXT NOT NULL,\n  idempotency_key TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS mesh_replication_offsets (\n  consumer_node_id TEXT NOT NULL,\n  source_node_id TEXT NOT NULL,\n  last_replication_id TEXT,\n  updated_at TEXT NOT NULL,\n  PRIMARY KEY (consumer_node_id, source_node_id)\n);\nCREATE TABLE IF NOT EXISTS mesh_session_owners (\n  session_id TEXT PRIMARY KEY,\n  owner_node_id TEXT NOT NULL,\n  epoch BIGINT NOT NULL,\n  claimed_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS mutation_idempotency (\n  method TEXT NOT NULL,\n  route_path TEXT NOT NULL,\n  idempotency_key TEXT NOT NULL,\n  actor_scope TEXT NOT NULL DEFAULT '',\n  payload_hash TEXT NOT NULL,\n  status TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  PRIMARY KEY (method, route_path, idempotency_key, actor_scope)\n);\nCREATE TABLE IF NOT EXISTS operator_profiles (\n  operator_profile_id TEXT PRIMARY KEY,\n  workspace_id TEXT NOT NULL DEFAULT 'default',\n  summary TEXT NOT NULL DEFAULT '',\n  facts_json TEXT NOT NULL DEFAULT '[]',\n  revision BIGINT NOT NULL DEFAULT 0,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS orchestration_checkpoints (\n  checkpoint_id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  plan_id TEXT NOT NULL,\n  wave_id TEXT,\n  phase_id TEXT,\n  checkpoint_kind TEXT NOT NULL,\n  git_ref TEXT,\n  details_json TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS orchestration_events (\n  event_id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  event_type TEXT NOT NULL,\n  payload_json TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS orchestration_plans (\n  plan_id TEXT NOT NULL,\n  workspace_id TEXT NOT NULL DEFAULT 'default',\n  plan_json TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  PRIMARY KEY (plan_id, workspace_id)\n);\nCREATE TABLE IF NOT EXISTS orchestration_runs (\n  run_id TEXT PRIMARY KEY,\n  plan_id TEXT NOT NULL,\n  status TEXT NOT NULL,\n  started_at TEXT NOT NULL,\n  ended_at TEXT,\n  current_wave_id TEXT,\n  current_phase_id TEXT,\n  total_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,\n  total_iterations BIGINT NOT NULL DEFAULT 0,\n  wave_cost_usd_by_wave_id TEXT,\n  stop_reason TEXT,\n  workspace_id TEXT,\n  durable_run_id TEXT,\n  operator_id TEXT,\n  auth_actor_id TEXT,\n  auth_actor_source TEXT,\n  permission_profile_id TEXT,\n  local_operator_override_id TEXT,\n  execution_state TEXT,\n  worktree_path TEXT,\n  worktree_status TEXT,\n  worktree_base_ref TEXT,\n  pending_approval_phase_id TEXT,\n  pending_approved_by TEXT,\n  pending_cost_increment_usd DOUBLE PRECISION,\n  last_error TEXT\n);\nCREATE TABLE IF NOT EXISTS pending_approval_actions (\n  approval_id TEXT PRIMARY KEY,\n  action_type TEXT NOT NULL,\n  request_json TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  expires_at TEXT,\n  resolved_at TEXT,\n  resolution_status TEXT NOT NULL DEFAULT 'pending',\n  result_json TEXT\n);\nCREATE TABLE IF NOT EXISTS permission_profile_activations (\n  activation_id TEXT PRIMARY KEY,\n  profile_id TEXT NOT NULL,\n  operator_id TEXT,\n  workspace_id TEXT,\n  session_id TEXT,\n  surface TEXT,\n  active BIGINT NOT NULL DEFAULT 1,\n  created_by TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS permission_profiles (\n  profile_id TEXT PRIMARY KEY,\n  label TEXT NOT NULL,\n  description TEXT,\n  builtin BIGINT NOT NULL DEFAULT 0,\n  status TEXT NOT NULL,\n  scope TEXT NOT NULL,\n  scope_ref TEXT,\n  approval_mode TEXT NOT NULL,\n  legacy_tool_profile TEXT,\n  tool_patterns_json TEXT NOT NULL,\n  allow_json TEXT NOT NULL,\n  deny_json TEXT NOT NULL,\n  read_access_mode TEXT,\n  default_for_surfaces_json TEXT NOT NULL DEFAULT '[]',\n  created_by TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  archived_at TEXT\n);\nCREATE TABLE IF NOT EXISTS policy_blocks (\n  audit_event_id TEXT PRIMARY KEY,\n  timestamp TEXT NOT NULL,\n  agent_id TEXT NOT NULL,\n  session_id TEXT NOT NULL,\n  task_id TEXT,\n  run_id TEXT,\n  tool_name TEXT NOT NULL,\n  reason TEXT NOT NULL,\n  details_json TEXT NOT NULL,\n  matched_grant_id TEXT,\n  permission_profile_id TEXT,\n  local_operator_override_id TEXT,\n  approval_mode TEXT,\n  reason_codes_json TEXT\n);\nCREATE TABLE IF NOT EXISTS proactive_actions (\n  action_id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  session_id TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  status TEXT NOT NULL,\n  tool_name TEXT,\n  args_json TEXT,\n  result_json TEXT,\n  linked_task_id TEXT,\n  linked_durable_run_id TEXT,\n  approval_id TEXT,\n  trigger_source TEXT,\n  origin_surface TEXT,\n  external_reference_roots_json TEXT,\n  error TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT\n);\nCREATE TABLE IF NOT EXISTS proactive_runs (\n  run_id TEXT PRIMARY KEY,\n  session_id TEXT NOT NULL,\n  status TEXT NOT NULL,\n  mode TEXT NOT NULL,\n  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,\n  reasoning_summary TEXT,\n  action_count BIGINT NOT NULL DEFAULT 0,\n  suggested_actions_json TEXT NOT NULL,\n  executed_actions_json TEXT NOT NULL,\n  linked_task_id TEXT,\n  linked_durable_run_id TEXT,\n  approval_id TEXT,\n  trigger_source TEXT,\n  origin_surface TEXT,\n  next_wake_at TEXT,\n  stop_reason TEXT,\n  external_reference_roots_json TEXT,\n  resume_metadata_json TEXT,\n  error TEXT,\n  started_at TEXT NOT NULL,\n  finished_at TEXT\n);\nCREATE TABLE IF NOT EXISTS prompt_pack_auto_scores_v2 (\n  auto_score_id TEXT PRIMARY KEY,\n  pack_id TEXT NOT NULL,\n  test_id TEXT NOT NULL,\n  run_id TEXT NOT NULL,\n  scoring_schema_version TEXT NOT NULL,\n  scorer_version TEXT NOT NULL,\n  judge_rubric_version TEXT NOT NULL,\n  policy_hash TEXT NOT NULL,\n  policy_source TEXT NOT NULL,\n  score_state TEXT NOT NULL,\n  auto_verdict TEXT NOT NULL,\n  weighted_score DOUBLE PRECISION NOT NULL,\n  judge_status TEXT NOT NULL,\n  protocol_pass BIGINT NOT NULL DEFAULT 0,\n  record_json TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS prompt_pack_benchmark_item_dedup_audit (\n  item_id TEXT PRIMARY KEY,\n  benchmark_run_id TEXT NOT NULL,\n  pack_id TEXT NOT NULL,\n  test_id TEXT NOT NULL,\n  test_code TEXT NOT NULL,\n  provider_id TEXT NOT NULL,\n  model TEXT NOT NULL,\n  run_id TEXT,\n  score_id TEXT,\n  auto_score_id TEXT,\n  run_status TEXT NOT NULL,\n  total_score BIGINT,\n  weighted_score DOUBLE PRECISION,\n  verdict TEXT,\n  score_state TEXT,\n  failure_signal TEXT,\n  original_rowid BIGINT NOT NULL,\n  source_created_at TEXT,\n  archived_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS prompt_pack_benchmark_runs (\n  benchmark_run_id TEXT PRIMARY KEY,\n  pack_id TEXT NOT NULL,\n  status TEXT NOT NULL,\n  test_codes_json TEXT NOT NULL,\n  providers_json TEXT NOT NULL,\n  total_items BIGINT NOT NULL DEFAULT 0,\n  completed_items BIGINT NOT NULL DEFAULT 0,\n  claimed_by_worker_id TEXT,\n  claim_heartbeat_at TEXT,\n  claim_expires_at TEXT,\n  error TEXT,\n  started_at TEXT NOT NULL,\n  finished_at TEXT,\n  execution_style TEXT\n);\nCREATE TABLE IF NOT EXISTS prompt_pack_human_reviews_v2 (\n  review_id TEXT PRIMARY KEY,\n  pack_id TEXT NOT NULL,\n  test_id TEXT NOT NULL,\n  run_id TEXT NOT NULL,\n  auto_score_id TEXT,\n  reviewer_id TEXT NOT NULL,\n  override_verdict TEXT,\n  record_json TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS prompt_pack_runs (\n  run_id TEXT PRIMARY KEY,\n  pack_id TEXT NOT NULL,\n  test_id TEXT NOT NULL,\n  session_id TEXT,\n  status TEXT NOT NULL,\n  provider_id TEXT,\n  model TEXT,\n  response_text TEXT,\n  final_response_text TEXT,\n  final_response_signals_json TEXT,\n  derived_response_text TEXT,\n  derived_response_signals_json TEXT,\n  trace_json TEXT,\n  citations_json TEXT,\n  integrity_json TEXT,\n  error TEXT,\n  started_at TEXT NOT NULL,\n  finished_at TEXT,\n  mode TEXT,\n  tool_tier TEXT,\n  tool_autonomy TEXT,\n  web_mode TEXT,\n  memory_mode TEXT,\n  thinking_level TEXT,\n  execution_style TEXT,\n  diagnostic_metadata_json TEXT\n);\nCREATE TABLE IF NOT EXISTS prompt_pack_scores (\n  score_id TEXT PRIMARY KEY,\n  pack_id TEXT NOT NULL,\n  test_id TEXT NOT NULL,\n  run_id TEXT NOT NULL,\n  routing_score BIGINT NOT NULL,\n  honesty_score BIGINT NOT NULL,\n  handoff_score BIGINT NOT NULL,\n  robustness_score BIGINT NOT NULL,\n  usability_score BIGINT NOT NULL,\n  total_score BIGINT NOT NULL,\n  judge_json TEXT,\n  notes TEXT,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS prompt_pack_tests (\n  test_id TEXT PRIMARY KEY,\n  pack_id TEXT NOT NULL,\n  code TEXT NOT NULL,\n  title TEXT NOT NULL,\n  prompt TEXT NOT NULL,\n  order_index BIGINT NOT NULL DEFAULT 0,\n  created_at TEXT NOT NULL,\n  mode TEXT,\n  tool_tier TEXT,\n  diagnostic_metadata_json TEXT\n);\nCREATE TABLE IF NOT EXISTS prompt_packs (\n  pack_id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  source_label TEXT,\n  test_count BIGINT NOT NULL DEFAULT 0,\n  policy_v2_json TEXT NOT NULL DEFAULT '{\"scoringSchemaVersion\":\"v2\",\"threshold\":75,\"weights\":{\"taskSuccess\":35,\"honesty\":25,\"executionQuality\":20,\"robustness\":15,\"usability\":5},\"minScores\":{\"taskSuccess\":3,\"honesty\":2},\"judgeRequired\":true,\"reviewOnDisagreementAt\":2,\"criticalDimensionsMustBeApplicable\":true,\"hardFailSignals\":[\"tool_tier_violation\",\"unsupported_access_claim\",\"run_failed\",\"approval_paused\",\"missing_required_json\",\"missing_required_table\",\"missing_required_citation_evidence\"]}',\n  policy_v2_hash TEXT NOT NULL DEFAULT 'f14a6b61734cf2c67ded3b8059e503127e315fc4036711d5e51693f46572a0f6',\n  policy_v2_source TEXT NOT NULL DEFAULT 'inherited_default',\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS realtime_event_sequence_state (\n  stream_name TEXT PRIMARY KEY,\n  last_sequence BIGINT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS realtime_events (\n  event_id TEXT PRIMARY KEY,\n  event_type TEXT NOT NULL,\n  source TEXT NOT NULL,\n  payload_json TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  sequence BIGINT\n);\nCREATE TABLE IF NOT EXISTS realtime_stream_leases (\n  lease_id TEXT PRIMARY KEY,\n  stream_name TEXT NOT NULL,\n  client_id TEXT NOT NULL,\n  gateway_node_id TEXT NOT NULL,\n  requested_cursor BIGINT,\n  last_sent_sequence BIGINT,\n  state TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  last_heartbeat_at TEXT NOT NULL,\n  last_event_at TEXT,\n  closed_at TEXT,\n  close_reason TEXT\n);\nCREATE TABLE IF NOT EXISTS remote_action_tokens (\n  token_id TEXT PRIMARY KEY,\n  token_hash TEXT NOT NULL,\n  action_type TEXT NOT NULL,\n  approval_id TEXT,\n  connector_id TEXT NOT NULL,\n  mutation_json TEXT NOT NULL DEFAULT '{}',\n  created_at TEXT NOT NULL,\n  expires_at TEXT NOT NULL,\n  state TEXT NOT NULL DEFAULT 'pending',\n  consumed_at TEXT,\n  consumed_by TEXT\n);\nCREATE TABLE IF NOT EXISTS replay_override_runs (\n  replay_run_id TEXT PRIMARY KEY,\n  source_run_id TEXT NOT NULL,\n  status TEXT NOT NULL,\n  overrides_json TEXT NOT NULL,\n  diff_json TEXT,\n  started_at TEXT NOT NULL,\n  finished_at TEXT,\n  error_text TEXT\n);\nCREATE TABLE IF NOT EXISTS replay_regression_runs (\n  regression_run_id TEXT PRIMARY KEY,\n  pack_id TEXT NOT NULL,\n  status TEXT NOT NULL,\n  test_codes_json TEXT NOT NULL,\n  baseline_ref TEXT,\n  summary_json TEXT,\n  started_at TEXT NOT NULL,\n  finished_at TEXT,\n  error_text TEXT\n);\nCREATE TABLE IF NOT EXISTS research_runs (\n  run_id TEXT PRIMARY KEY,\n  session_id TEXT NOT NULL,\n  query TEXT NOT NULL,\n  mode TEXT NOT NULL,\n  status TEXT NOT NULL,\n  summary TEXT,\n  error TEXT,\n  started_at TEXT NOT NULL,\n  finished_at TEXT\n);\nCREATE TABLE IF NOT EXISTS research_sources (\n  source_id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  title TEXT,\n  url TEXT NOT NULL,\n  snippet TEXT,\n  rank BIGINT NOT NULL DEFAULT 0,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS runtime_decision_traces (\n  decision_id TEXT PRIMARY KEY,\n  kind TEXT NOT NULL,\n  workspace_id TEXT,\n  session_id TEXT,\n  turn_id TEXT,\n  run_id TEXT,\n  plan_id TEXT,\n  step_id TEXT,\n  tool_run_id TEXT,\n  approval_id TEXT,\n  task_id TEXT,\n  durable_run_id TEXT,\n  payload_json TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  citadel_id TEXT\n);\nCREATE TABLE IF NOT EXISTS runtime_evidence_envelopes (\n  envelope_id TEXT PRIMARY KEY,\n  event_kind TEXT NOT NULL,\n  workspace_id TEXT,\n  session_id TEXT,\n  turn_id TEXT,\n  run_id TEXT,\n  approval_id TEXT,\n  content_hash TEXT NOT NULL,\n  previous_envelope_hash TEXT,\n  payload_hash TEXT NOT NULL,\n  tool_call_hashes_json TEXT NOT NULL DEFAULT '[]',\n  memory_lineage_json TEXT NOT NULL DEFAULT '[]',\n  policy_hash TEXT,\n  signature_status TEXT NOT NULL,\n  signature TEXT,\n  metadata_json TEXT NOT NULL DEFAULT '{}',\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS session_autonomy_prefs (\n  session_id TEXT PRIMARY KEY,\n  proactive_mode TEXT NOT NULL DEFAULT 'off',\n  max_actions_per_hour BIGINT NOT NULL DEFAULT 6,\n  max_actions_per_turn BIGINT NOT NULL DEFAULT 2,\n  cooldown_seconds BIGINT NOT NULL DEFAULT 60,\n  retrieval_mode TEXT NOT NULL DEFAULT 'standard',\n  reflection_mode TEXT NOT NULL DEFAULT 'off',\n  last_proactive_at TEXT,\n  last_proactive_run_id TEXT,\n  heartbeat_enabled BIGINT NOT NULL DEFAULT 1,\n  heartbeat_interval_seconds BIGINT NOT NULL DEFAULT 3600,\n  active_hours_json TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS sessions (\n  session_id TEXT PRIMARY KEY,\n  session_key TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  channel TEXT NOT NULL,\n  account TEXT NOT NULL,\n  display_name TEXT,\n  routing_hints_json TEXT,\n  last_activity_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  health TEXT NOT NULL DEFAULT 'healthy',\n  token_input BIGINT NOT NULL DEFAULT 0,\n  token_output BIGINT NOT NULL DEFAULT 0,\n  token_cached_input BIGINT NOT NULL DEFAULT 0,\n  token_total BIGINT NOT NULL DEFAULT 0,\n  cost_usd_total DOUBLE PRECISION NOT NULL DEFAULT 0,\n  budget_state TEXT NOT NULL DEFAULT 'ok'\n);\nCREATE TABLE IF NOT EXISTS skill_activation_events (\n  event_id TEXT PRIMARY KEY,\n  skill_id TEXT NOT NULL,\n  event_type TEXT NOT NULL,\n  payload_json TEXT,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS skill_evaluation_runs (\n  run_id TEXT PRIMARY KEY,\n  skill_id TEXT NOT NULL,\n  skill_name TEXT NOT NULL,\n  status TEXT NOT NULL,\n  target_pass_rate DOUBLE PRECISION NOT NULL,\n  max_rounds BIGINT NOT NULL,\n  accepted BIGINT NOT NULL DEFAULT 0,\n  improvement_delta DOUBLE PRECISION NOT NULL DEFAULT 0,\n  proposal_id TEXT,\n  improvement_candidate_id TEXT,\n  ledger_signal_id TEXT,\n  record_json TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS skill_lifecycle (\n  skill_id TEXT PRIMARY KEY,\n  capability_category TEXT NOT NULL,\n  lifecycle_state TEXT NOT NULL,\n  trust_label TEXT NOT NULL,\n  review_warning TEXT,\n  provenance_json TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS skill_state (\n  skill_id TEXT PRIMARY KEY,\n  state TEXT NOT NULL DEFAULT 'enabled',\n  note TEXT,\n  updated_at TEXT NOT NULL,\n  first_auto_approved_at TEXT\n);\nCREATE TABLE IF NOT EXISTS skills_index (\n  skill_id TEXT PRIMARY KEY,\n  skill_name TEXT NOT NULL,\n  source TEXT NOT NULL,\n  dir TEXT NOT NULL,\n  mtime TEXT NOT NULL,\n  declared_tools_json TEXT NOT NULL,\n  requires_json TEXT NOT NULL,\n  keywords_json TEXT NOT NULL,\n  usage_count BIGINT NOT NULL DEFAULT 0,\n  avg_quality_score DOUBLE PRECISION NOT NULL DEFAULT 0\n);\nCREATE TABLE IF NOT EXISTS state_validation_quarantine (\n  quarantine_id TEXT PRIMARY KEY,\n  store TEXT NOT NULL,\n  row_id TEXT NOT NULL,\n  raw_value TEXT,\n  schema_error TEXT NOT NULL,\n  observed_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS system_settings (\n  setting_key TEXT PRIMARY KEY,\n  value_json TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS tasks (\n  task_id TEXT PRIMARY KEY,\n  title TEXT NOT NULL,\n  description TEXT,\n  status TEXT NOT NULL,\n  priority TEXT NOT NULL,\n  assigned_agent_id TEXT,\n  created_by TEXT,\n  due_at TEXT,\n  metadata_json TEXT,\n  deleted_at TEXT,\n  deleted_by TEXT,\n  delete_reason TEXT,\n  distress_signals_json TEXT,\n  retry_budget_json TEXT,\n  artifact_verification_json TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  workspace_id TEXT NOT NULL DEFAULT 'default'\n);\nCREATE TABLE IF NOT EXISTS tool_access_decisions (\n  decision_id TEXT PRIMARY KEY,\n  timestamp TEXT NOT NULL,\n  tool_name TEXT NOT NULL,\n  agent_id TEXT NOT NULL,\n  session_id TEXT NOT NULL,\n  task_id TEXT,\n  run_id TEXT,\n  allowed BIGINT NOT NULL,\n  reason_codes_json TEXT NOT NULL,\n  matched_grant_id TEXT,\n  requires_approval BIGINT NOT NULL,\n  risk_level TEXT NOT NULL,\n  counts_toward_limits BIGINT NOT NULL DEFAULT 1,\n  workspace_id TEXT,\n  permission_profile_id TEXT,\n  local_operator_override_id TEXT\n);\nCREATE TABLE IF NOT EXISTS tool_grants (\n  grant_id TEXT PRIMARY KEY,\n  tool_pattern TEXT NOT NULL,\n  decision TEXT NOT NULL,\n  scope TEXT NOT NULL,\n  scope_ref TEXT NOT NULL,\n  grant_type TEXT NOT NULL,\n  constraints_json TEXT,\n  created_by TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  expires_at TEXT,\n  revoked_at TEXT,\n  revoked_by TEXT,\n  uses_remaining BIGINT\n);\nCREATE TABLE IF NOT EXISTS tool_invocations (\n  audit_event_id TEXT PRIMARY KEY,\n  timestamp TEXT NOT NULL,\n  agent_id TEXT NOT NULL,\n  session_id TEXT NOT NULL,\n  task_id TEXT,\n  run_id TEXT,\n  tool_name TEXT NOT NULL,\n  outcome TEXT NOT NULL,\n  policy_reason TEXT NOT NULL,\n  args_json TEXT NOT NULL,\n  result_json TEXT,\n  approval_id TEXT,\n  matched_grant_id TEXT,\n  permission_profile_id TEXT,\n  local_operator_override_id TEXT,\n  approval_mode TEXT,\n  reason_codes_json TEXT\n);\nCREATE TABLE IF NOT EXISTS transcript_outbox (\n  event_id TEXT PRIMARY KEY,\n  session_id TEXT NOT NULL,\n  event_json TEXT NOT NULL,\n  enqueued_at TEXT NOT NULL,\n  delivered_at TEXT,\n  transcript_offset BIGINT,\n  attempt_count BIGINT NOT NULL DEFAULT 0,\n  last_attempt_at TEXT,\n  last_error TEXT\n);\nCREATE TABLE IF NOT EXISTS voice_sessions (\n  voice_session_id TEXT PRIMARY KEY,\n  talk_session_id TEXT,\n  mode TEXT NOT NULL,\n  state TEXT NOT NULL,\n  session_id TEXT,\n  payload_json TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS voice_wake_profiles (\n  profile_id TEXT PRIMARY KEY,\n  label TEXT NOT NULL,\n  model TEXT NOT NULL,\n  enabled BIGINT NOT NULL DEFAULT 1,\n  sensitivity DOUBLE PRECISION,\n  payload_json TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS workspace_hooks (\n  hook_id TEXT PRIMARY KEY,\n  workspace_id TEXT NOT NULL,\n  label TEXT NOT NULL,\n  trigger TEXT NOT NULL,\n  mode TEXT NOT NULL,\n  enabled BIGINT NOT NULL DEFAULT 1,\n  priority BIGINT NOT NULL DEFAULT 100,\n  timeout_ms BIGINT NOT NULL DEFAULT 5000,\n  fail_policy TEXT NOT NULL DEFAULT 'open',\n  action_json TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS workspace_memory_maintenance_policies (\n  workspace_id TEXT PRIMARY KEY,\n  enabled BIGINT NOT NULL DEFAULT 0,\n  run_mode TEXT NOT NULL,\n  timing_strategy TEXT NOT NULL,\n  schedule_json TEXT,\n  time_zone TEXT NOT NULL,\n  min_hours_since_last_success BIGINT NOT NULL DEFAULT 24,\n  min_changed_sessions BIGINT NOT NULL DEFAULT 3,\n  provider_id TEXT,\n  model TEXT,\n  execution_target TEXT NOT NULL,\n  unavailable_model_policy TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS workspace_memory_maintenance_state (\n  workspace_id TEXT PRIMARY KEY,\n  last_eligibility_at TEXT,\n  last_successful_run_at TEXT,\n  changed_session_count BIGINT NOT NULL DEFAULT 0,\n  active_run_id TEXT,\n  last_recommendation_at TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS workspaces (\n  workspace_id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  description TEXT,\n  slug TEXT NOT NULL,\n  lifecycle_status TEXT NOT NULL DEFAULT 'active',\n  archived_at TEXT,\n  workspace_prefs_json TEXT NOT NULL DEFAULT '{}',\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  citadel_id TEXT NOT NULL DEFAULT 'personal'\n);\nCREATE TABLE IF NOT EXISTS approval_effects (\n  effect_id TEXT PRIMARY KEY,\n  approval_id TEXT NOT NULL,\n  effect_kind TEXT NOT NULL,\n  target_kind TEXT NOT NULL,\n  target_id TEXT NOT NULL,\n  idempotency_key TEXT NOT NULL,\n  status TEXT NOT NULL,\n  outcome TEXT,\n  detail TEXT,\n  attempt_count BIGINT NOT NULL DEFAULT 0,\n  details_json TEXT NOT NULL DEFAULT '{}',\n  payload_json TEXT NOT NULL DEFAULT '{}',\n  result_json TEXT NOT NULL DEFAULT '{}',\n  last_error TEXT,\n  claimed_by TEXT,\n  claimed_at TEXT,\n  lease_expires_at TEXT,\n  version BIGINT NOT NULL DEFAULT 1,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  completed_at TEXT,\n  FOREIGN KEY (approval_id) REFERENCES approvals(approval_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS approval_wait_runs (\n  approval_id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  resolved_at TEXT,\n  FOREIGN KEY (approval_id) REFERENCES approvals(approval_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS assembly_artifacts (\n  artifact_id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  round_index BIGINT NOT NULL,\n  stage TEXT NOT NULL,\n  artifact_type TEXT NOT NULL,\n  participant_model_ref TEXT,\n  blinded_author_token TEXT,\n  payload_json TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (run_id) REFERENCES assembly_runs(run_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS assembly_rounds (\n  round_id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  round_index BIGINT NOT NULL,\n  stage TEXT NOT NULL,\n  status TEXT NOT NULL,\n  participant_ids_json TEXT NOT NULL,\n  artifact_ids_json TEXT NOT NULL,\n  convergence_snapshot_json TEXT,\n  stop_check_json TEXT,\n  started_at TEXT NOT NULL,\n  finished_at TEXT,\n  FOREIGN KEY (run_id) REFERENCES assembly_runs(run_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS auth_device_grants (\n  grant_id TEXT PRIMARY KEY,\n  request_id TEXT NOT NULL,\n  token_hash TEXT NOT NULL,\n  device_label TEXT NOT NULL,\n  device_type TEXT NOT NULL,\n  platform TEXT,\n  granted_by TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  expires_at TEXT,\n  last_used_at TEXT,\n  revoked_at TEXT,\n  metadata_json TEXT NOT NULL DEFAULT '{}',\n  FOREIGN KEY (request_id) REFERENCES auth_device_requests(request_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS capability_proposal_events (\n  event_id TEXT PRIMARY KEY,\n  proposal_id TEXT NOT NULL,\n  event_type TEXT NOT NULL,\n  actor_id TEXT NOT NULL,\n  payload_json TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (proposal_id) REFERENCES capability_proposals(proposal_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS chat_attachments (\n  attachment_id TEXT PRIMARY KEY,\n  session_id TEXT NOT NULL,\n  project_id TEXT,\n  file_name TEXT NOT NULL,\n  mime_type TEXT NOT NULL,\n  size_bytes BIGINT NOT NULL,\n  sha256 TEXT NOT NULL,\n  storage_rel_path TEXT NOT NULL,\n  extract_status TEXT NOT NULL,\n  extract_preview TEXT,\n  created_at TEXT NOT NULL,\n  media_type TEXT,\n  thumbnail_rel_path TEXT,\n  ocr_text TEXT,\n  transcript_text TEXT,\n  analysis_status TEXT NOT NULL DEFAULT 'pending',\n  workspace_id TEXT NOT NULL DEFAULT 'default',\n  FOREIGN KEY (project_id) REFERENCES chat_projects(project_id) ON DELETE SET NULL\n);\nCREATE TABLE IF NOT EXISTS chat_session_projects (\n  session_id TEXT PRIMARY KEY,\n  project_id TEXT NOT NULL,\n  assigned_at TEXT NOT NULL,\n  FOREIGN KEY (project_id) REFERENCES chat_projects(project_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS chat_session_workbench (\n  session_id TEXT PRIMARY KEY,\n  project_id TEXT,\n  base_ref TEXT,\n  worktree_path TEXT,\n  worktree_status TEXT NOT NULL DEFAULT 'uninitialized',\n  active_file_path TEXT,\n  diff_artifact_id TEXT,\n  output_artifact_id TEXT,\n  validation_status TEXT NOT NULL DEFAULT 'idle',\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  package_manager TEXT,\n  FOREIGN KEY (project_id) REFERENCES chat_projects(project_id) ON DELETE SET NULL\n);\nCREATE TABLE IF NOT EXISTS chat_side_chats (\n  side_chat_id TEXT PRIMARY KEY,\n  parent_session_id TEXT NOT NULL,\n  child_session_id TEXT NOT NULL,\n  workspace_id TEXT NOT NULL DEFAULT 'default',\n  created_from_surface TEXT NOT NULL DEFAULT 'chat',\n  source_turn_id TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  FOREIGN KEY (child_session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,\n  FOREIGN KEY (parent_session_id) REFERENCES sessions(session_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS context_manifest_entries (\n  entry_id TEXT PRIMARY KEY,\n  manifest_id TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  entry_index BIGINT NOT NULL,\n  title TEXT,\n  source_ref TEXT,\n  content_text TEXT,\n  content_hash TEXT NOT NULL,\n  metadata_json TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (manifest_id) REFERENCES context_manifests(manifest_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS decision_autotunes (\n  tune_id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  finding_id TEXT,\n  tune_class TEXT NOT NULL,\n  risk_level TEXT NOT NULL,\n  status TEXT NOT NULL,\n  description TEXT NOT NULL,\n  patch_json TEXT NOT NULL,\n  snapshot_json TEXT,\n  result_json TEXT,\n  created_at TEXT NOT NULL,\n  applied_at TEXT,\n  reverted_at TEXT,\n  FOREIGN KEY (run_id) REFERENCES decision_replay_runs(run_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS decision_replay_findings (\n  finding_id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  fingerprint TEXT NOT NULL,\n  cause_class TEXT NOT NULL,\n  cluster_key TEXT NOT NULL,\n  severity TEXT NOT NULL,\n  recurrence_count BIGINT NOT NULL DEFAULT 0,\n  impacted_sessions BIGINT NOT NULL DEFAULT 0,\n  impacted_turns BIGINT NOT NULL DEFAULT 0,\n  avg_wrongness DOUBLE PRECISION NOT NULL DEFAULT 0,\n  title TEXT NOT NULL,\n  summary TEXT NOT NULL,\n  recommendation TEXT,\n  is_duplicate BIGINT NOT NULL DEFAULT 0,\n  duplicate_of_fingerprint TEXT,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (run_id) REFERENCES decision_replay_runs(run_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS decision_replay_items (\n  item_id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  decision_type TEXT NOT NULL,\n  session_id TEXT,\n  turn_id TEXT,\n  tool_run_id TEXT,\n  occurred_at TEXT NOT NULL,\n  wrongness_probability DOUBLE PRECISION NOT NULL DEFAULT 0,\n  label TEXT NOT NULL,\n  cause_class TEXT NOT NULL,\n  cluster_key TEXT NOT NULL,\n  rule_scores_json TEXT NOT NULL,\n  model_scores_json TEXT,\n  evidence_json TEXT NOT NULL,\n  summary_text TEXT,\n  input_excerpt TEXT,\n  output_excerpt TEXT,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (run_id) REFERENCES decision_replay_runs(run_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS durable_checkpoints (\n  checkpoint_id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  checkpoint_kind TEXT NOT NULL,\n  state_json TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (run_id) REFERENCES durable_runs(run_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS durable_dead_letters (\n  dead_letter_id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  reason TEXT NOT NULL,\n  payload_json TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  resolved_at TEXT,\n  resolution_note TEXT,\n  FOREIGN KEY (run_id) REFERENCES durable_runs(run_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS durable_retries (\n  retry_id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  attempt_no BIGINT NOT NULL,\n  reason TEXT NOT NULL,\n  next_retry_at TEXT,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (run_id) REFERENCES durable_runs(run_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS durable_run_events (\n  event_id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  event_type TEXT NOT NULL,\n  step_key TEXT,\n  payload_json TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (run_id) REFERENCES durable_runs(run_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS improvement_candidate_revisions (\n  revision_id TEXT PRIMARY KEY,\n  candidate_id TEXT NOT NULL,\n  candidate_ref_json TEXT NOT NULL,\n  change_hash TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  created_by_actor_id TEXT NOT NULL,\n  created_by_actor_type TEXT NOT NULL,\n  FOREIGN KEY (candidate_id) REFERENCES improvement_candidates(candidate_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS improvement_candidate_signals (\n  candidate_id TEXT NOT NULL,\n  signal_id TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  PRIMARY KEY (candidate_id, signal_id),\n  FOREIGN KEY (signal_id) REFERENCES improvement_signals(signal_id) ON DELETE CASCADE,\n  FOREIGN KEY (candidate_id) REFERENCES improvement_candidates(candidate_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS improvement_reports (\n  report_id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  week_start TEXT NOT NULL,\n  week_end TEXT NOT NULL,\n  summary_json TEXT NOT NULL,\n  top_findings_json TEXT NOT NULL,\n  applied_tunes_json TEXT NOT NULL,\n  queued_tunes_json TEXT NOT NULL,\n  week_over_week_json TEXT NOT NULL,\n  previous_report_id TEXT,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (run_id) REFERENCES decision_replay_runs(run_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS knowledge_chunks (\n  chunk_id TEXT PRIMARY KEY,\n  doc_id TEXT NOT NULL,\n  seq BIGINT NOT NULL,\n  content TEXT NOT NULL,\n  embedding_json TEXT,\n  embedding_metadata_json TEXT,\n  token_estimate BIGINT NOT NULL DEFAULT 0,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (doc_id) REFERENCES knowledge_documents(doc_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS mcp_server_auth (\n  server_id TEXT PRIMARY KEY,\n  access_token_ref TEXT,\n  refresh_token_ref TEXT,\n  token_expires_at TEXT,\n  oauth_state TEXT,\n  scopes_json TEXT,\n  updated_at TEXT NOT NULL,\n  FOREIGN KEY (server_id) REFERENCES mcp_servers(server_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS mcp_tools_cache (\n  cache_id TEXT PRIMARY KEY,\n  server_id TEXT NOT NULL,\n  tool_name TEXT NOT NULL,\n  description TEXT,\n  input_schema_json TEXT,\n  enabled BIGINT NOT NULL DEFAULT 1,\n  updated_at TEXT NOT NULL,\n  FOREIGN KEY (server_id) REFERENCES mcp_servers(server_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS media_artifacts (\n  artifact_id TEXT PRIMARY KEY,\n  job_id TEXT NOT NULL,\n  attachment_id TEXT,\n  kind TEXT NOT NULL,\n  storage_rel_path TEXT,\n  text_preview TEXT,\n  mime_type TEXT,\n  size_bytes BIGINT,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (job_id) REFERENCES media_jobs(job_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS memory_change_history (\n  change_id TEXT PRIMARY KEY,\n  item_id TEXT NOT NULL,\n  change_type TEXT NOT NULL,\n  actor_id TEXT,\n  payload_json TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (item_id) REFERENCES memory_items(item_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS memory_maintenance_run_changes (\n  change_id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  change_kind TEXT NOT NULL,\n  target_kind TEXT NOT NULL,\n  target_ref TEXT NOT NULL,\n  before_ref TEXT,\n  after_ref TEXT,\n  summary TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (run_id) REFERENCES memory_maintenance_runs(run_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS memory_maintenance_run_sources (\n  source_id TEXT PRIMARY KEY,\n  run_id TEXT NOT NULL,\n  source_kind TEXT NOT NULL,\n  source_ref TEXT NOT NULL,\n  modified_at TEXT,\n  excerpt TEXT,\n  token_estimate BIGINT,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (run_id) REFERENCES memory_maintenance_runs(run_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS memory_relations (\n  relation_id TEXT PRIMARY KEY,\n  workspace_id TEXT NOT NULL,\n  scope TEXT NOT NULL,\n  title TEXT NOT NULL,\n  from_entity_id TEXT NOT NULL,\n  to_entity_id TEXT NOT NULL,\n  relation_type TEXT NOT NULL,\n  status TEXT NOT NULL DEFAULT 'active',\n  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,\n  source_refs_json TEXT NOT NULL,\n  metadata_json TEXT NOT NULL,\n  authority TEXT NOT NULL,\n  degraded_reason TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  forgotten_at TEXT,\n  superseded_by_id TEXT,\n  FOREIGN KEY (to_entity_id) REFERENCES memory_entities(entity_id) ON DELETE RESTRICT,\n  FOREIGN KEY (from_entity_id) REFERENCES memory_entities(entity_id) ON DELETE RESTRICT\n);\nCREATE TABLE IF NOT EXISTS prompt_pack_benchmark_items (\n  item_id TEXT PRIMARY KEY,\n  benchmark_run_id TEXT NOT NULL,\n  pack_id TEXT NOT NULL,\n  test_id TEXT NOT NULL,\n  test_code TEXT NOT NULL,\n  provider_id TEXT NOT NULL,\n  model TEXT NOT NULL,\n  run_id TEXT,\n  score_id TEXT,\n  auto_score_id TEXT,\n  run_status TEXT NOT NULL,\n  total_score BIGINT,\n  weighted_score DOUBLE PRECISION,\n  verdict TEXT,\n  score_state TEXT,\n  failure_signal TEXT,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (benchmark_run_id) REFERENCES prompt_pack_benchmark_runs(benchmark_run_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS replay_override_steps (\n  step_id TEXT PRIMARY KEY,\n  replay_run_id TEXT NOT NULL,\n  step_key TEXT NOT NULL,\n  override_kind TEXT NOT NULL,\n  override_json TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (replay_run_id) REFERENCES replay_override_runs(replay_run_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS replay_regression_results (\n  result_id TEXT PRIMARY KEY,\n  regression_run_id TEXT NOT NULL,\n  test_code TEXT NOT NULL,\n  capability TEXT NOT NULL,\n  score_delta DOUBLE PRECISION NOT NULL,\n  pass_delta DOUBLE PRECISION NOT NULL,\n  latency_delta_ms DOUBLE PRECISION NOT NULL,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (regression_run_id) REFERENCES replay_regression_runs(regression_run_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS task_activities (\n  activity_id TEXT PRIMARY KEY,\n  task_id TEXT NOT NULL,\n  agent_id TEXT,\n  activity_type TEXT NOT NULL,\n  message TEXT NOT NULL,\n  metadata_json TEXT,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS task_deliverables (\n  deliverable_id TEXT PRIMARY KEY,\n  task_id TEXT NOT NULL,\n  deliverable_type TEXT NOT NULL,\n  title TEXT NOT NULL,\n  path TEXT,\n  description TEXT,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS task_subagent_sessions (\n  subagent_session_id TEXT PRIMARY KEY,\n  task_id TEXT NOT NULL,\n  agent_session_id TEXT NOT NULL,\n  agent_name TEXT,\n  status TEXT NOT NULL,\n  metadata_json TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  ended_at TEXT,\n  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS companion_sessions (\n  session_id TEXT PRIMARY KEY,\n  grant_id TEXT NOT NULL,\n  access_token_hash TEXT NOT NULL,\n  access_token_expires_at TEXT NOT NULL,\n  refresh_token_hash TEXT NOT NULL,\n  refresh_token_expires_at TEXT NOT NULL,\n  signing_public_key_pem TEXT NOT NULL,\n  signature_algorithm TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  last_rotated_at TEXT NOT NULL,\n  last_seen_at TEXT,\n  revoked_at TEXT,\n  metadata_json TEXT NOT NULL DEFAULT '{}',\n  FOREIGN KEY (grant_id) REFERENCES auth_device_grants(grant_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS improvement_activations (\n  activation_id TEXT PRIMARY KEY,\n  candidate_id TEXT NOT NULL,\n  revision_id TEXT NOT NULL,\n  approval_id TEXT NOT NULL,\n  status TEXT NOT NULL,\n  scope TEXT NOT NULL,\n  activation_target_json TEXT NOT NULL,\n  pre_activation_snapshot_json TEXT NOT NULL,\n  applied_change_hash TEXT NOT NULL,\n  watch_status TEXT NOT NULL,\n  watch_started_at TEXT,\n  watch_ends_at TEXT,\n  watch_signal_target BIGINT NOT NULL DEFAULT 20,\n  watch_signal_count BIGINT NOT NULL DEFAULT 0,\n  regression_count BIGINT NOT NULL DEFAULT 0,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  requested_by_actor_id TEXT NOT NULL,\n  requested_by_actor_type TEXT NOT NULL,\n  approved_by_actor_id TEXT,\n  approved_by_actor_type TEXT,\n  paused_by_actor_id TEXT,\n  paused_by_actor_type TEXT,\n  rolled_back_by_actor_id TEXT,\n  rolled_back_by_actor_type TEXT,\n  stable_at TEXT,\n  paused_at TEXT,\n  rolled_back_at TEXT,\n  failure_reason TEXT,\n  FOREIGN KEY (revision_id) REFERENCES improvement_candidate_revisions(revision_id) ON DELETE CASCADE,\n  FOREIGN KEY (candidate_id) REFERENCES improvement_candidates(candidate_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS improvement_evaluations (\n  evaluation_id TEXT PRIMARY KEY,\n  candidate_id TEXT NOT NULL,\n  revision_id TEXT NOT NULL,\n  status TEXT NOT NULL,\n  baseline_ref_json TEXT NOT NULL,\n  candidate_ref_json TEXT NOT NULL,\n  evaluator_kind TEXT NOT NULL,\n  evaluator_version TEXT NOT NULL,\n  dataset_or_pack_ref_json TEXT,\n  change_hash TEXT NOT NULL,\n  metrics_json TEXT NOT NULL DEFAULT '{}',\n  result_summary TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  completed_at TEXT,\n  created_by_actor_id TEXT NOT NULL,\n  created_by_actor_type TEXT NOT NULL,\n  completed_by_actor_id TEXT,\n  completed_by_actor_type TEXT,\n  FOREIGN KEY (revision_id) REFERENCES improvement_candidate_revisions(revision_id) ON DELETE CASCADE,\n  FOREIGN KEY (candidate_id) REFERENCES improvement_candidates(candidate_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS companion_request_replays (\n  session_id TEXT NOT NULL,\n  nonce TEXT NOT NULL,\n  method TEXT NOT NULL,\n  path TEXT NOT NULL,\n  request_hash TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  expires_at TEXT NOT NULL,\n  PRIMARY KEY (session_id, nonce),\n  FOREIGN KEY (session_id) REFERENCES companion_sessions(session_id) ON DELETE CASCADE\n);\nCREATE INDEX IF NOT EXISTS idx_a2a_task_bindings_local_task ON a2a_task_bindings(local_task_id);\nCREATE INDEX IF NOT EXISTS idx_a2a_task_bindings_context_peer ON a2a_task_bindings(peer_id, context_id, updated_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_a2a_task_bindings_idempotency ON a2a_task_bindings(peer_id, idempotency_key);\nCREATE INDEX IF NOT EXISTS idx_a2a_task_push_configs_retry ON a2a_task_push_configs(last_delivery_status, next_retry_at);\nCREATE INDEX IF NOT EXISTS idx_a2a_task_push_configs_peer_updated ON a2a_task_push_configs(peer_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_agent_commitments_status_due ON agent_commitments(status, due_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_agent_commitments_session_dedupe ON agent_commitments(session_id, dedupe_key);\nCREATE INDEX IF NOT EXISTS idx_agent_profiles_role_id ON agent_profiles(role_id);\nCREATE INDEX IF NOT EXISTS idx_agent_profiles_lifecycle_status ON agent_profiles(lifecycle_status, updated_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profiles_role_id_unique ON agent_profiles(role_id);\nCREATE INDEX IF NOT EXISTS idx_approval_events_approval_id ON approval_events(approval_id, timestamp);\nCREATE INDEX IF NOT EXISTS idx_approval_inbox_approval_created ON approval_inbox_items(approval_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_approval_inbox_receiver_state_created ON approval_inbox_items(receiver_kind, receiver_id, state, created_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_approval_inbox_receiver_token ON approval_inbox_items(receiver_kind, receiver_id, token_id);\nCREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, created_at);\nCREATE INDEX IF NOT EXISTS idx_assembly_reputation_provider_model ON assembly_reputation(provider_id, model_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_assembly_reputation_overall ON assembly_reputation(overall, sample_count, updated_at);\nCREATE INDEX IF NOT EXISTS idx_assembly_runs_source_session ON assembly_runs(source_session_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_assembly_runs_workspace_updated ON assembly_runs(workspace_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_assembly_runs_status_updated ON assembly_runs(status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_auth_device_requests_expires_at ON auth_device_requests(expires_at);\nCREATE INDEX IF NOT EXISTS idx_auth_device_requests_status_created ON auth_device_requests(status, created_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_auth_device_requests_approval_id_unique ON auth_device_requests(approval_id);\nCREATE INDEX IF NOT EXISTS idx_autonomy_audit_unreverted ON autonomy_audit(reverted, occurred_at);\nCREATE INDEX IF NOT EXISTS idx_autonomy_audit_since ON autonomy_audit(occurred_at);\nCREATE INDEX IF NOT EXISTS idx_candidate_skill_versions_candidate ON candidate_skill_versions(candidate_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_capability_proposals_status_updated ON capability_proposals(status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_channel_setup_drafts_lifecycle ON channel_setup_drafts(lifecycle_mode, updated_at);\nCREATE INDEX IF NOT EXISTS idx_channel_setup_drafts_connection ON channel_setup_drafts(connection_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_channel_setup_drafts_catalog ON channel_setup_drafts(catalog_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_conversation_summaries_branch ON chat_conversation_summaries(session_id, branch_head_turn_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_chat_conversation_summaries_session ON chat_conversation_summaries(session_id, created_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_chat_conversation_summaries_session_id_branch_head_turn_id_start_turn_id_end_turn_id_unique ON chat_conversation_summaries(session_id, branch_head_turn_id, start_turn_id, end_turn_id);\nCREATE INDEX IF NOT EXISTS idx_chat_delegation_runs_parent ON chat_delegation_runs(parent_run_id, started_at);\nCREATE INDEX IF NOT EXISTS idx_chat_delegation_runs_task ON chat_delegation_runs(task_id, started_at);\nCREATE INDEX IF NOT EXISTS idx_chat_delegation_runs_session ON chat_delegation_runs(session_id, started_at);\nCREATE INDEX IF NOT EXISTS idx_chat_delegation_steps_run ON chat_delegation_steps(run_id, step_index, started_at);\nCREATE INDEX IF NOT EXISTS idx_chat_execution_plan_steps_plan ON chat_execution_plan_steps(plan_id, step_index);\nCREATE INDEX IF NOT EXISTS idx_chat_execution_plans_turn ON chat_execution_plans(turn_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_chat_execution_plans_session ON chat_execution_plans(session_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_chat_generated_artifacts_surface_kind_created ON chat_generated_artifacts(source_surface, kind, created_at);\nCREATE INDEX IF NOT EXISTS idx_chat_generated_artifacts_project_created ON chat_generated_artifacts(project_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_chat_generated_artifacts_workspace_created ON chat_generated_artifacts(workspace_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_chat_generated_artifacts_turn_created ON chat_generated_artifacts(turn_id, version, created_at);\nCREATE INDEX IF NOT EXISTS idx_chat_generated_artifacts_session_created ON chat_generated_artifacts(session_id, created_at, version);\nCREATE INDEX IF NOT EXISTS idx_chat_inline_approvals_turn ON chat_inline_approvals(turn_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_chat_inline_approvals_session ON chat_inline_approvals(session_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_chat_messages_session_message ON chat_messages(session_id, message_id);\nCREATE INDEX IF NOT EXISTS idx_chat_messages_session_seq ON chat_messages(session_id, seq);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_message_id_unique ON chat_messages(message_id);\nCREATE INDEX IF NOT EXISTS idx_chat_projects_workspace_updated ON chat_projects(workspace_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_projects_lifecycle ON chat_projects(lifecycle_status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_projects_updated_at ON chat_projects(updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_reflection_attempts_session ON chat_reflection_attempts(session_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_chat_reflection_attempts_turn ON chat_reflection_attempts(turn_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_chat_session_bindings_workspace_updated ON chat_session_bindings(workspace_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_session_branch_state_updated ON chat_session_branch_state(updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_session_meta_workspace_updated ON chat_session_meta(workspace_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_session_meta_folder ON chat_session_meta(workspace_id, folder_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_session_meta_history_visibility ON chat_session_meta(workspace_id, include_in_history, lifecycle_status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_session_meta_pinned ON chat_session_meta(pinned, updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_session_meta_lifecycle ON chat_session_meta(lifecycle_status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_session_meta_updated_at ON chat_session_meta(updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_session_prefs_updated ON chat_session_prefs(updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_specialist_candidates_workspace ON chat_specialist_candidates(workspace_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_specialist_candidates_status ON chat_specialist_candidates(status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_specialist_candidates_session ON chat_specialist_candidates(session_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_stream_events_created ON chat_stream_events(created_at);\nCREATE INDEX IF NOT EXISTS idx_chat_stream_events_session_turn ON chat_stream_events(session_id, turn_id, sequence);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_chat_stream_events_turn_sequence ON chat_stream_events(turn_id, sequence);\nCREATE INDEX IF NOT EXISTS idx_chat_thread_knowledge_attachments_document ON chat_thread_knowledge_attachments(document_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_thread_knowledge_attachments_session_mode ON chat_thread_knowledge_attachments(session_id, retrieval_mode, ingest_status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_thread_knowledge_attachments_session_created ON chat_thread_knowledge_attachments(session_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_chat_tool_artifacts_session ON chat_tool_artifacts(session_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_chat_tool_artifacts_tool_run ON chat_tool_artifacts(tool_run_id);\nCREATE INDEX IF NOT EXISTS idx_chat_tool_artifacts_turn ON chat_tool_artifacts(turn_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_chat_tool_runs_session_status ON chat_tool_runs(session_id, status, started_at);\nCREATE INDEX IF NOT EXISTS idx_chat_tool_runs_approval ON chat_tool_runs(approval_id);\nCREATE INDEX IF NOT EXISTS idx_chat_tool_runs_session ON chat_tool_runs(session_id, started_at);\nCREATE INDEX IF NOT EXISTS idx_chat_tool_runs_turn ON chat_tool_runs(turn_id, started_at);\nCREATE INDEX IF NOT EXISTS idx_chat_turn_traces_session_status ON chat_turn_traces(session_id, status, started_at);\nCREATE INDEX IF NOT EXISTS idx_chat_turn_traces_execution_plan ON chat_turn_traces(execution_plan_id);\nCREATE INDEX IF NOT EXISTS idx_chat_turn_traces_session_parent_started ON chat_turn_traces(session_id, parent_turn_id, started_at);\nCREATE INDEX IF NOT EXISTS idx_chat_turn_traces_session ON chat_turn_traces(session_id, started_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_citadel_agent_assignments_unique ON citadel_agent_assignments(citadel_id, agent_id);\nCREATE INDEX IF NOT EXISTS idx_citadel_chambers_citadel ON citadel_chambers(citadel_id, name);\nCREATE INDEX IF NOT EXISTS idx_citadel_integration_grants_citadel ON citadel_integration_grants(citadel_id, created_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_citadel_members_unique ON citadel_members(citadel_id, subject_id);\nCREATE INDEX IF NOT EXISTS idx_citadel_passages_source ON citadel_passages(source_citadel_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_citadel_records_lifecycle_updated ON citadel_records(lifecycle_status, updated_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_citadel_records_slug_unique ON citadel_records(slug);\nCREATE INDEX IF NOT EXISTS idx_citadel_vault_secrets_citadel ON citadel_vault_secrets(citadel_id, created_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_citadel_vault_secrets_name ON citadel_vault_secrets(citadel_id, secret_name);\nCREATE INDEX IF NOT EXISTS idx_citadel_wards_citadel ON citadel_wards(citadel_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_code_mode_runs_workspace_status_created ON code_mode_runs(workspace_id, status, created_at, run_id);\nCREATE INDEX IF NOT EXISTS idx_code_mode_runs_session_status_created ON code_mode_runs(session_id, status, created_at, run_id);\nCREATE INDEX IF NOT EXISTS idx_code_mode_runs_approval ON code_mode_runs(approval_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_code_mode_runs_session_created ON code_mode_runs(session_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_code_mode_runs_status_created ON code_mode_runs(status, created_at, run_id);\nCREATE INDEX IF NOT EXISTS idx_comms_deliveries_due ON comms_deliveries(status, next_attempt_at, created_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_comms_deliveries_idempotency ON comms_deliveries(idempotency_key) WHERE idempotency_key IS NOT NULL;\nCREATE INDEX IF NOT EXISTS idx_comms_deliveries_channel_time ON comms_deliveries(channel_key, created_at);\nCREATE INDEX IF NOT EXISTS idx_comms_deliveries_connection_time ON comms_deliveries(connection_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_connector_health_runs_connector ON connector_health_runs(connector_type, connector_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_context_manifests_turn ON context_manifests(turn_id);\nCREATE INDEX IF NOT EXISTS idx_context_manifests_session ON context_manifests(session_id, created_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_context_manifests_turn_id_unique ON context_manifests(turn_id);\nCREATE INDEX IF NOT EXISTS idx_cost_ledger_day_provider ON cost_ledger(day, provider_id);\nCREATE INDEX IF NOT EXISTS idx_cost_ledger_created_at ON cost_ledger(created_at);\nCREATE INDEX IF NOT EXISTS idx_cost_ledger_session_id ON cost_ledger(session_id);\nCREATE INDEX IF NOT EXISTS idx_cost_ledger_day ON cost_ledger(day);\nCREATE INDEX IF NOT EXISTS idx_cron_jobs_citadel ON cron_jobs(citadel_id, job_id);\nCREATE INDEX IF NOT EXISTS idx_cron_review_items_job_created ON cron_review_items(job_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_cron_review_items_status_updated ON cron_review_items(status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_cron_run_diffs_run ON cron_run_diffs(run_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_daemon_events_created ON daemon_events(created_at);\nCREATE INDEX IF NOT EXISTS idx_decision_replay_runs_status ON decision_replay_runs(status, started_at);\nCREATE INDEX IF NOT EXISTS idx_decision_replay_runs_started ON decision_replay_runs(started_at);\nCREATE INDEX IF NOT EXISTS idx_durable_runs_workflow_created ON durable_runs(workflow_key, created_at);\nCREATE INDEX IF NOT EXISTS idx_durable_runs_status_lease_updated ON durable_runs(status, lease_expires_at, updated_at);\nCREATE INDEX IF NOT EXISTS idx_durable_runs_status_updated ON durable_runs(status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_external_connector_review_states_service ON external_connector_review_states(source_id, service_id, action_id);\nCREATE INDEX IF NOT EXISTS idx_external_connector_review_states_workspace ON external_connector_review_states(workspace_id, status, pinned, updated_at);\nCREATE INDEX IF NOT EXISTS idx_external_side_effect_runs_connection_created ON external_side_effect_runs(connection_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_external_side_effect_runs_status_updated ON external_side_effect_runs(status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_external_side_effect_runs_workspace_created ON external_side_effect_runs(workspace_id, created_at, run_id);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_external_side_effect_runs_idempotency ON external_side_effect_runs(route_path, idempotency_key, actor_scope);\nCREATE INDEX IF NOT EXISTS idx_hook_runs_durable ON hook_runs(durable_run_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_hook_runs_workspace_created ON hook_runs(workspace_id, created_at, run_id);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_hook_runs_hook_idempotency ON hook_runs(hook_id, idempotency_key);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_imported_agent_catalog_source_path ON imported_agent_catalog(workspace_id, provenance_provider, provenance_path);\nCREATE INDEX IF NOT EXISTS idx_imported_agent_catalog_workspace_parse ON imported_agent_catalog(workspace_id, parse_status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_imported_agent_catalog_workspace_state ON imported_agent_catalog(workspace_id, state, updated_at);\nCREATE INDEX IF NOT EXISTS idx_imported_agent_catalog_workspace_division ON imported_agent_catalog(workspace_id, division, updated_at);\nCREATE INDEX IF NOT EXISTS idx_imported_agent_catalog_workspace ON imported_agent_catalog(workspace_id, updated_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_imported_agent_catalog_definition_id_unique ON imported_agent_catalog(definition_id);\nCREATE INDEX IF NOT EXISTS idx_improvement_candidates_workspace_updated ON improvement_candidates(workspace_id, updated_at, candidate_id);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_improvement_candidates_open_fingerprint ON improvement_candidates(workspace_id, kind, fingerprint) WHERE status IN ('proposed', 'evaluating', 'ready_for_approval', 'approval_pending', 'approved');\nCREATE INDEX IF NOT EXISTS idx_improvement_signals_workspace_fingerprint ON improvement_signals(workspace_id, fingerprint, recorded_at);\nCREATE INDEX IF NOT EXISTS idx_improvement_signals_workspace_recorded ON improvement_signals(workspace_id, recorded_at, signal_id);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_improvement_signals_source_idempotency ON improvement_signals(source_service, idempotency_key);\nCREATE INDEX IF NOT EXISTS idx_integration_connections_catalog_id ON integration_connections(catalog_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_integration_connections_kind ON integration_connections(kind, updated_at);\nCREATE INDEX IF NOT EXISTS idx_knowledge_documents_namespace_time ON knowledge_documents(namespace, created_at);\nCREATE INDEX IF NOT EXISTS idx_learned_memory_conflicts_status ON learned_memory_conflicts(status, created_at);\nCREATE INDEX IF NOT EXISTS idx_learned_memory_conflicts_session ON learned_memory_conflicts(session_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_learned_memory_items_status ON learned_memory_items(status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_learned_memory_items_type ON learned_memory_items(item_type, created_at);\nCREATE INDEX IF NOT EXISTS idx_learned_memory_items_session_created ON learned_memory_items(session_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_learned_memory_sources_item ON learned_memory_sources(item_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_llm_eval_proof_runs_session ON llm_eval_proof_runs(session_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_llm_eval_proof_runs_created ON llm_eval_proof_runs(created_at);\nCREATE INDEX IF NOT EXISTS idx_llm_runtime_measurements_source_status ON llm_runtime_measurements(source, status, collected_at);\nCREATE INDEX IF NOT EXISTS idx_llm_runtime_measurements_session ON llm_runtime_measurements(session_id, collected_at);\nCREATE INDEX IF NOT EXISTS idx_llm_runtime_measurements_provider_model_collected ON llm_runtime_measurements(provider_id, model, collected_at);\nCREATE INDEX IF NOT EXISTS idx_local_operator_overrides_active ON local_operator_overrides(status, operator_id, scope, scope_ref, expires_at);\nCREATE INDEX IF NOT EXISTS idx_mason_sessions_updated ON mason_sessions(updated_at);\nCREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled, updated_at);\nCREATE INDEX IF NOT EXISTS idx_mcp_servers_updated ON mcp_servers(updated_at);\nCREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_media_jobs_attachment ON media_jobs(attachment_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_media_jobs_session ON media_jobs(session_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_memory_context_packs_created_at ON memory_context_packs(created_at);\nCREATE INDEX IF NOT EXISTS idx_memory_context_packs_run_phase ON memory_context_packs(run_id, phase_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_memory_context_packs_session ON memory_context_packs(session_id, created_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_memory_context_packs_cache_key_unique ON memory_context_packs(cache_key);\nCREATE INDEX IF NOT EXISTS idx_memory_decisions_session ON memory_decisions(session_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_memory_decisions_review_at ON memory_decisions(review_at, status);\nCREATE INDEX IF NOT EXISTS idx_memory_decisions_workspace_status ON memory_decisions(workspace_id, status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_memory_entities_type ON memory_entities(entity_type, updated_at);\nCREATE INDEX IF NOT EXISTS idx_memory_entities_workspace_status ON memory_entities(workspace_id, status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_memory_items_workspace ON memory_items(workspace_id, status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_memory_items_pinned_updated ON memory_items(pinned, updated_at);\nCREATE INDEX IF NOT EXISTS idx_memory_items_namespace_status ON memory_items(namespace, status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_memory_maintenance_recommendations_workspace_created ON memory_maintenance_recommendations(workspace_id, created_at, recommendation_id);\nCREATE INDEX IF NOT EXISTS idx_memory_maintenance_recommendations_workspace_status ON memory_maintenance_recommendations(workspace_id, status, updated_at, recommendation_id);\nCREATE INDEX IF NOT EXISTS idx_memory_maintenance_runs_workspace_status_created ON memory_maintenance_runs(workspace_id, status, created_at, run_id);\nCREATE INDEX IF NOT EXISTS idx_memory_maintenance_runs_workspace_created ON memory_maintenance_runs(workspace_id, created_at, run_id);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_memory_maintenance_runs_durable_run_id_unique ON memory_maintenance_runs(durable_run_id);\nCREATE INDEX IF NOT EXISTS idx_memory_qmd_runs_run_phase ON memory_qmd_runs(run_id, phase_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_memory_qmd_runs_session ON memory_qmd_runs(session_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_memory_qmd_runs_scope ON memory_qmd_runs(scope, created_at);\nCREATE INDEX IF NOT EXISTS idx_memory_qmd_runs_created_at ON memory_qmd_runs(created_at);\nCREATE INDEX IF NOT EXISTS idx_memory_quality_issues_target ON memory_quality_issues(target_kind, target_ref, updated_at);\nCREATE INDEX IF NOT EXISTS idx_memory_quality_issues_kind_status ON memory_quality_issues(kind, status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_memory_quality_issues_workspace_status ON memory_quality_issues(workspace_id, status, updated_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_memory_quality_issues_dedup_key_unique ON memory_quality_issues(dedup_key);\nCREATE INDEX IF NOT EXISTS idx_memory_structured_history_record ON memory_structured_change_history(record_kind, record_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_mesh_join_tokens_expires_at ON mesh_join_tokens(expires_at);\nCREATE INDEX IF NOT EXISTS idx_mesh_leases_expires_at ON mesh_leases(expires_at);\nCREATE INDEX IF NOT EXISTS idx_mesh_nodes_status ON mesh_nodes(status, last_seen_at);\nCREATE INDEX IF NOT EXISTS idx_mesh_replication_log_created_at ON mesh_replication_log(created_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_mesh_replication_log_source_node_id_idempotency_key_unique ON mesh_replication_log(source_node_id, idempotency_key);\nCREATE INDEX IF NOT EXISTS idx_mesh_session_owners_owner ON mesh_session_owners(owner_node_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_mutation_idempotency_updated ON mutation_idempotency(updated_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_operator_profiles_workspace ON operator_profiles(workspace_id);\nCREATE INDEX IF NOT EXISTS idx_orchestration_checkpoints_run_id ON orchestration_checkpoints(run_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_orchestration_events_run_id ON orchestration_events(run_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_orchestration_plans_workspace ON orchestration_plans(workspace_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_orchestration_runs_durable_run_id ON orchestration_runs(durable_run_id);\nCREATE INDEX IF NOT EXISTS idx_orchestration_runs_plan_id ON orchestration_runs(plan_id, started_at);\nCREATE INDEX IF NOT EXISTS idx_permission_profile_activations_lookup ON permission_profile_activations(active, operator_id, workspace_id, session_id, surface, updated_at);\nCREATE INDEX IF NOT EXISTS idx_permission_profiles_scope_status ON permission_profiles(scope, scope_ref, status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_policy_blocks_session_time ON policy_blocks(session_id, timestamp);\nCREATE INDEX IF NOT EXISTS idx_proactive_actions_status ON proactive_actions(status, created_at);\nCREATE INDEX IF NOT EXISTS idx_proactive_actions_run ON proactive_actions(run_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_proactive_actions_session_created ON proactive_actions(session_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_proactive_runs_durable ON proactive_runs(linked_durable_run_id, started_at);\nCREATE INDEX IF NOT EXISTS idx_proactive_runs_approval ON proactive_runs(approval_id, started_at);\nCREATE INDEX IF NOT EXISTS idx_proactive_runs_status ON proactive_runs(status, started_at);\nCREATE INDEX IF NOT EXISTS idx_proactive_runs_session_created ON proactive_runs(session_id, started_at);\nCREATE INDEX IF NOT EXISTS idx_prompt_pack_auto_scores_v2_verdict ON prompt_pack_auto_scores_v2(auto_verdict, created_at);\nCREATE INDEX IF NOT EXISTS idx_prompt_pack_auto_scores_v2_run ON prompt_pack_auto_scores_v2(run_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_prompt_pack_auto_scores_v2_pack_test ON prompt_pack_auto_scores_v2(pack_id, test_id, created_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_pack_auto_scores_v2_run_version ON prompt_pack_auto_scores_v2(run_id, scoring_schema_version, scorer_version, policy_hash);\nCREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_runs_claim ON prompt_pack_benchmark_runs(status, claim_expires_at, started_at);\nCREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_runs_status ON prompt_pack_benchmark_runs(status, started_at);\nCREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_runs_pack_started ON prompt_pack_benchmark_runs(pack_id, started_at);\nCREATE INDEX IF NOT EXISTS idx_prompt_pack_human_reviews_v2_run ON prompt_pack_human_reviews_v2(run_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_prompt_pack_human_reviews_v2_pack_test ON prompt_pack_human_reviews_v2(pack_id, test_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_prompt_pack_runs_test ON prompt_pack_runs(test_id, started_at);\nCREATE INDEX IF NOT EXISTS idx_prompt_pack_runs_pack ON prompt_pack_runs(pack_id, started_at);\nCREATE INDEX IF NOT EXISTS idx_prompt_pack_scores_pack_test ON prompt_pack_scores(pack_id, test_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_prompt_pack_tests_pack_order ON prompt_pack_tests(pack_id, order_index, created_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_pack_tests_pack_code ON prompt_pack_tests(pack_id, code);\nCREATE INDEX IF NOT EXISTS idx_prompt_packs_updated ON prompt_packs(updated_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_realtime_events_sequence ON realtime_events(sequence);\nCREATE INDEX IF NOT EXISTS idx_realtime_events_created_at ON realtime_events(created_at);\nCREATE INDEX IF NOT EXISTS idx_realtime_stream_leases_node_state_updated ON realtime_stream_leases(gateway_node_id, state, updated_at);\nCREATE INDEX IF NOT EXISTS idx_realtime_stream_leases_client_state_updated ON realtime_stream_leases(client_id, state, updated_at);\nCREATE INDEX IF NOT EXISTS idx_realtime_stream_leases_stream_state_updated ON realtime_stream_leases(stream_name, state, updated_at);\nCREATE INDEX IF NOT EXISTS idx_remote_action_tokens_expires_at ON remote_action_tokens(expires_at);\nCREATE INDEX IF NOT EXISTS idx_remote_action_tokens_connector_state ON remote_action_tokens(connector_id, state, created_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_remote_action_tokens_token_hash_unique ON remote_action_tokens(token_hash);\nCREATE INDEX IF NOT EXISTS idx_replay_override_runs_status ON replay_override_runs(status, started_at);\nCREATE INDEX IF NOT EXISTS idx_replay_override_runs_source ON replay_override_runs(source_run_id, started_at);\nCREATE INDEX IF NOT EXISTS idx_replay_regression_runs_status_started ON replay_regression_runs(status, started_at);\nCREATE INDEX IF NOT EXISTS idx_replay_regression_runs_pack_started ON replay_regression_runs(pack_id, started_at);\nCREATE INDEX IF NOT EXISTS idx_research_runs_session ON research_runs(session_id, started_at);\nCREATE INDEX IF NOT EXISTS idx_research_sources_run ON research_sources(run_id, rank, created_at);\nCREATE INDEX IF NOT EXISTS idx_runtime_decision_traces_citadel_created ON runtime_decision_traces(citadel_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_runtime_decision_traces_created ON runtime_decision_traces(created_at);\nCREATE INDEX IF NOT EXISTS idx_runtime_decision_traces_approval ON runtime_decision_traces(approval_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_runtime_decision_traces_plan ON runtime_decision_traces(plan_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_runtime_decision_traces_run ON runtime_decision_traces(run_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_runtime_decision_traces_session_turn ON runtime_decision_traces(session_id, turn_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_runtime_evidence_kind_created ON runtime_evidence_envelopes(event_kind, created_at);\nCREATE INDEX IF NOT EXISTS idx_runtime_evidence_run_created ON runtime_evidence_envelopes(run_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_runtime_evidence_turn_created ON runtime_evidence_envelopes(turn_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_runtime_evidence_workspace_created ON runtime_evidence_envelopes(workspace_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_runtime_evidence_session_created ON runtime_evidence_envelopes(session_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_session_autonomy_prefs_updated ON session_autonomy_prefs(updated_at);\nCREATE INDEX IF NOT EXISTS idx_sessions_account_last_activity_at ON sessions(account, last_activity_at);\nCREATE INDEX IF NOT EXISTS idx_sessions_last_activity_at ON sessions(last_activity_at);\nCREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_key_unique ON sessions(session_key);\nCREATE INDEX IF NOT EXISTS idx_skill_activation_events_skill ON skill_activation_events(skill_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_skill_evaluation_runs_status_updated ON skill_evaluation_runs(status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_skill_evaluation_runs_skill_updated ON skill_evaluation_runs(skill_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_skill_lifecycle_category ON skill_lifecycle(capability_category, lifecycle_state, updated_at);\nCREATE INDEX IF NOT EXISTS idx_skill_state_state_updated ON skill_state(state, updated_at);\nCREATE INDEX IF NOT EXISTS idx_state_validation_quarantine_store_observed ON state_validation_quarantine(store, observed_at);\nCREATE INDEX IF NOT EXISTS idx_tasks_workspace_status_updated ON tasks(workspace_id, status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_tasks_workspace_updated ON tasks(workspace_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_tasks_status_updated_at ON tasks(status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_tool_access_decisions_run_time ON tool_access_decisions(run_id, timestamp);\nCREATE INDEX IF NOT EXISTS idx_tool_access_decisions_task_allowed_tool_time ON tool_access_decisions(task_id, allowed, tool_name, timestamp);\nCREATE INDEX IF NOT EXISTS idx_tool_access_decisions_session_allowed_tool_time ON tool_access_decisions(agent_id, session_id, allowed, tool_name, timestamp);\nCREATE INDEX IF NOT EXISTS idx_tool_access_decisions_agent_allowed_tool_time ON tool_access_decisions(agent_id, allowed, tool_name, timestamp);\nCREATE INDEX IF NOT EXISTS idx_tool_access_decisions_allowed_tool_time ON tool_access_decisions(allowed, tool_name, timestamp);\nCREATE INDEX IF NOT EXISTS idx_tool_access_decisions_tool_task_time ON tool_access_decisions(tool_name, task_id, timestamp);\nCREATE INDEX IF NOT EXISTS idx_tool_access_decisions_tool_agent_session_time ON tool_access_decisions(tool_name, agent_id, session_id, timestamp);\nCREATE INDEX IF NOT EXISTS idx_tool_access_decisions_agent_time ON tool_access_decisions(agent_id, timestamp);\nCREATE INDEX IF NOT EXISTS idx_tool_access_decisions_tool_time ON tool_access_decisions(tool_name, timestamp);\nCREATE INDEX IF NOT EXISTS idx_tool_grants_pattern ON tool_grants(tool_pattern, created_at);\nCREATE INDEX IF NOT EXISTS idx_tool_grants_scope ON tool_grants(scope, scope_ref, created_at);\nCREATE INDEX IF NOT EXISTS idx_tool_invocations_session_time ON tool_invocations(session_id, timestamp);\nCREATE INDEX IF NOT EXISTS idx_transcript_outbox_session_pending ON transcript_outbox(session_id, delivered_at, enqueued_at, event_id);\nCREATE INDEX IF NOT EXISTS idx_transcript_outbox_pending ON transcript_outbox(delivered_at, enqueued_at, event_id);\nCREATE INDEX IF NOT EXISTS idx_voice_sessions_updated ON voice_sessions(updated_at);\nCREATE INDEX IF NOT EXISTS idx_voice_wake_profiles_enabled ON voice_wake_profiles(enabled, updated_at);\nCREATE INDEX IF NOT EXISTS idx_workspace_hooks_workspace_trigger ON workspace_hooks(workspace_id, trigger, enabled, priority, created_at);\nCREATE INDEX IF NOT EXISTS idx_workspace_hooks_workspace_priority ON workspace_hooks(workspace_id, priority, created_at);\nCREATE INDEX IF NOT EXISTS idx_workspace_memory_maintenance_policies_enabled ON workspace_memory_maintenance_policies(enabled, updated_at);\nCREATE INDEX IF NOT EXISTS idx_workspace_memory_maintenance_state_active_run ON workspace_memory_maintenance_state(active_run_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_workspaces_citadel_updated ON workspaces(citadel_id, lifecycle_status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_workspaces_lifecycle ON workspaces(lifecycle_status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_workspaces_updated ON workspaces(updated_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_slug_unique ON workspaces(slug);\nCREATE INDEX IF NOT EXISTS idx_approval_effects_status_lease_updated ON approval_effects(status, lease_expires_at, updated_at);\nCREATE INDEX IF NOT EXISTS idx_approval_effects_approval_created ON approval_effects(approval_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_approval_effects_lookup ON approval_effects(approval_id, effect_kind, target_kind, target_id);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_approval_effects_idempotency ON approval_effects(idempotency_key);\nCREATE INDEX IF NOT EXISTS idx_approval_wait_runs_run_id ON approval_wait_runs(run_id);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_approval_wait_runs_run_id_unique ON approval_wait_runs(run_id);\nCREATE INDEX IF NOT EXISTS idx_assembly_artifacts_type_created ON assembly_artifacts(artifact_type, created_at);\nCREATE INDEX IF NOT EXISTS idx_assembly_artifacts_run_round ON assembly_artifacts(run_id, round_index, created_at);\nCREATE INDEX IF NOT EXISTS idx_assembly_rounds_stage_status ON assembly_rounds(stage, status, started_at);\nCREATE INDEX IF NOT EXISTS idx_assembly_rounds_run_round ON assembly_rounds(run_id, round_index, started_at);\nCREATE INDEX IF NOT EXISTS idx_auth_device_grants_revoked ON auth_device_grants(revoked_at, created_at);\nCREATE INDEX IF NOT EXISTS idx_auth_device_grants_last_used ON auth_device_grants(last_used_at);\nCREATE INDEX IF NOT EXISTS idx_auth_device_grants_expires_at ON auth_device_grants(expires_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_auth_device_grants_token_hash_unique ON auth_device_grants(token_hash);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_auth_device_grants_request_id_unique ON auth_device_grants(request_id);\nCREATE INDEX IF NOT EXISTS idx_capability_proposal_events_proposal ON capability_proposal_events(proposal_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_chat_attachments_workspace_created ON chat_attachments(workspace_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_chat_attachments_project ON chat_attachments(project_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_chat_attachments_session ON chat_attachments(session_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_chat_session_projects_project ON chat_session_projects(project_id, assigned_at);\nCREATE INDEX IF NOT EXISTS idx_chat_session_workbench_status ON chat_session_workbench(worktree_status, validation_status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_session_workbench_project ON chat_session_workbench(project_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_chat_side_chats_workspace_parent ON chat_side_chats(workspace_id, parent_session_id);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_chat_side_chats_child_session_id_unique ON chat_side_chats(child_session_id);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_chat_side_chats_parent_session_id_unique ON chat_side_chats(parent_session_id);\nCREATE INDEX IF NOT EXISTS idx_context_manifest_entries_manifest ON context_manifest_entries(manifest_id, entry_index, created_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_context_manifest_entries_manifest_id_kind_source_ref_content_hash_unique ON context_manifest_entries(manifest_id, kind, source_ref, content_hash);\nCREATE INDEX IF NOT EXISTS idx_decision_autotunes_run_status ON decision_autotunes(run_id, status, created_at);\nCREATE INDEX IF NOT EXISTS idx_decision_replay_findings_fingerprint ON decision_replay_findings(fingerprint, created_at);\nCREATE INDEX IF NOT EXISTS idx_decision_replay_findings_run ON decision_replay_findings(run_id, is_duplicate, recurrence_count);\nCREATE INDEX IF NOT EXISTS idx_decision_replay_items_cause ON decision_replay_items(cause_class, label, occurred_at);\nCREATE INDEX IF NOT EXISTS idx_decision_replay_items_run_wrongness ON decision_replay_items(run_id, wrongness_probability, occurred_at);\nCREATE INDEX IF NOT EXISTS idx_durable_checkpoints_run_created ON durable_checkpoints(run_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_durable_dead_letters_resolved ON durable_dead_letters(resolved_at, created_at);\nCREATE INDEX IF NOT EXISTS idx_durable_dead_letters_created ON durable_dead_letters(created_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_durable_dead_letters_run_id_unique ON durable_dead_letters(run_id);\nCREATE INDEX IF NOT EXISTS idx_durable_retries_next_retry ON durable_retries(next_retry_at, run_id);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_durable_retries_run_attempt ON durable_retries(run_id, attempt_no);\nCREATE INDEX IF NOT EXISTS idx_durable_run_events_run_created ON durable_run_events(run_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_improvement_candidate_revisions_candidate ON improvement_candidate_revisions(candidate_id, created_at, revision_id);\nCREATE INDEX IF NOT EXISTS idx_improvement_reports_week ON improvement_reports(week_end, created_at);\nCREATE INDEX IF NOT EXISTS idx_knowledge_chunks_created_at ON knowledge_chunks(created_at);\nCREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc_seq ON knowledge_chunks(doc_id, seq);\nCREATE INDEX IF NOT EXISTS idx_mcp_tools_cache_server ON mcp_tools_cache(server_id, updated_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_tools_cache_server_id_tool_name_unique ON mcp_tools_cache(server_id, tool_name);\nCREATE INDEX IF NOT EXISTS idx_media_artifacts_job ON media_artifacts(job_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_memory_change_history_item ON memory_change_history(item_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_memory_maintenance_run_changes_run ON memory_maintenance_run_changes(run_id, created_at, change_id);\nCREATE INDEX IF NOT EXISTS idx_memory_maintenance_run_sources_run ON memory_maintenance_run_sources(run_id, created_at, source_id);\nCREATE INDEX IF NOT EXISTS idx_memory_relations_entities ON memory_relations(from_entity_id, to_entity_id, updated_at);\nCREATE INDEX IF NOT EXISTS idx_memory_relations_workspace_status ON memory_relations(workspace_id, status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_items_test ON prompt_pack_benchmark_items(test_code, created_at);\nCREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_items_model ON prompt_pack_benchmark_items(provider_id, model, created_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_items_unique ON prompt_pack_benchmark_items(benchmark_run_id, provider_id, model, test_id);\nCREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_items_run ON prompt_pack_benchmark_items(benchmark_run_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_replay_override_steps_run ON replay_override_steps(replay_run_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_replay_regression_results_run_capability ON replay_regression_results(regression_run_id, capability, created_at);\nCREATE INDEX IF NOT EXISTS idx_task_activities_task_created_at ON task_activities(task_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_task_deliverables_task_created_at ON task_deliverables(task_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_task_subagent_sessions_agent_status_updated ON task_subagent_sessions(agent_session_id, status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_task_subagent_sessions_status ON task_subagent_sessions(status, updated_at);\nCREATE INDEX IF NOT EXISTS idx_task_subagent_sessions_task_created_at ON task_subagent_sessions(task_id, created_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_task_subagent_sessions_agent_session_id_unique ON task_subagent_sessions(agent_session_id);\nCREATE INDEX IF NOT EXISTS idx_companion_sessions_refresh_expires ON companion_sessions(refresh_token_expires_at);\nCREATE INDEX IF NOT EXISTS idx_companion_sessions_access_expires ON companion_sessions(access_token_expires_at);\nCREATE INDEX IF NOT EXISTS idx_companion_sessions_grant_active ON companion_sessions(grant_id, revoked_at, created_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_companion_sessions_refresh_token_hash_unique ON companion_sessions(refresh_token_hash);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_companion_sessions_access_token_hash_unique ON companion_sessions(access_token_hash);\nCREATE INDEX IF NOT EXISTS idx_improvement_activations_approval ON improvement_activations(approval_id, created_at);\nCREATE INDEX IF NOT EXISTS idx_improvement_activations_candidate ON improvement_activations(candidate_id, created_at, activation_id);\nCREATE INDEX IF NOT EXISTS idx_improvement_evaluations_candidate ON improvement_evaluations(candidate_id, created_at, evaluation_id);\nCREATE INDEX IF NOT EXISTS idx_companion_request_replays_expires ON companion_request_replays(expires_at);\nINSERT INTO realtime_event_sequence_state (stream_name, last_sequence) VALUES ('events', 0) ON CONFLICT (stream_name) DO NOTHING;\nINSERT INTO workspaces (workspace_id, name, description, slug, lifecycle_status, archived_at, workspace_prefs_json, created_at, updated_at, citadel_id) VALUES ('default', 'Default Workspace', 'Auto-migrated workspace for existing GoatCitadel data.', 'default', 'active', NULL, '{}', '2026-06-24 00:53:50', '2026-06-24 00:53:50', 'personal') ON CONFLICT (workspace_id) DO NOTHING;";

// FROZEN WITH V81: these helpers only define the bounded legacy remote-approval
// bearer scrub. Once v81 ships, change neither the matcher nor the generated
// statement shape; any later correction must be a new forward migration.
const POSTGRES_V81_BATCH_SIZE = 250;
const POSTGRES_V81_REMOTE_APPROVAL_BEARER_PATTERN = "grat_[A-Za-z0-9_-]{43}";

function buildPostgresV81BoundedUpdate(input: {
  table: string;
  keyColumns: readonly string[];
  predicate: string;
  assignments: string;
}): string {
  const selectedKeys = input.keyColumns.join(", ");
  const joinPredicate = input.keyColumns.map((column) => `target.${column} = scrub_batch.${column}`).join(" AND ");
  return `
    WITH scrub_batch AS (
      SELECT ${selectedKeys}
      FROM ${input.table}
      WHERE ${input.predicate}
      ORDER BY ${selectedKeys}
      LIMIT ${POSTGRES_V81_BATCH_SIZE}
      FOR UPDATE
    )
    UPDATE ${input.table} AS target
    SET ${input.assignments}
    FROM scrub_batch
    WHERE ${joinPredicate}
  `;
}

function postgresV81BearerMatch(column: string): string {
  return `${column} ~ '${POSTGRES_V81_REMOTE_APPROVAL_BEARER_PATTERN}'`;
}

function postgresV81BearerPredicate(columns: readonly string[]): string {
  return columns.map(postgresV81BearerMatch).join(" OR ");
}

function postgresV81RedactAssignments(columns: readonly string[]): string {
  return columns
    .map(
      (column) =>
        `${column} = regexp_replace(${column}, '${POSTGRES_V81_REMOTE_APPROVAL_BEARER_PATTERN}', '[REDACTED]', 'g')`,
    )
    .join(",\n        ");
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
        ADD COLUMN IF NOT EXISTS workspace_id TEXT,
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
        ADD COLUMN IF NOT EXISTS provider_id TEXT,
        ADD COLUMN IF NOT EXISTS model_id TEXT,
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

      CREATE INDEX IF NOT EXISTS idx_cost_ledger_day_provider
        ON cost_ledger(day, provider_id);

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

      ${POSTGRES_V7_FROZEN_SCHEMA_SQL}
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
        execution_backend_json TEXT,
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
        ADD COLUMN IF NOT EXISTS execution_backend_json TEXT,
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
  {
    version: 56,
    name: "code_mode_execution_backend_identity",
    sql: `
      ALTER TABLE IF EXISTS code_mode_runs
        ADD COLUMN IF NOT EXISTS execution_backend_json TEXT;
    `,
  },
  {
    version: 57,
    name: "external_side_effect_run_ledger",
    sql: `
      CREATE TABLE IF NOT EXISTS external_side_effect_runs (
        run_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        boundary TEXT NOT NULL,
        route_path TEXT NOT NULL,
        catalog_id TEXT,
        connection_id TEXT,
        action_id TEXT,
        actor_scope TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        replay_policy TEXT NOT NULL,
        replay_outcome TEXT,
        replay_attempt TEXT,
        resume_state TEXT NOT NULL,
        request_payload_json TEXT,
        response_payload_json TEXT,
        external_reference_id TEXT,
        envelope_id TEXT,
        error_text TEXT,
        attempt_count BIGINT NOT NULL DEFAULT 0,
        external_call_started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_external_side_effect_runs_idempotency
        ON external_side_effect_runs(route_path, idempotency_key, actor_scope);
      CREATE INDEX IF NOT EXISTS idx_external_side_effect_runs_workspace_created
        ON external_side_effect_runs(workspace_id, created_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS idx_external_side_effect_runs_status_updated
        ON external_side_effect_runs(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_external_side_effect_runs_connection_created
        ON external_side_effect_runs(connection_id, created_at DESC);
    `,
  },
  {
    version: 58,
    name: "memory_quality_issues",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_quality_issues (
        issue_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        dedup_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        severity TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_ref TEXT NOT NULL,
        related_refs_json TEXT NOT NULL DEFAULT '[]',
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL,
        rationale TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution_note TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memory_quality_issues_workspace_status
        ON memory_quality_issues(workspace_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_quality_issues_kind_status
        ON memory_quality_issues(kind, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_quality_issues_target
        ON memory_quality_issues(target_kind, target_ref, updated_at DESC);
    `,
  },
  {
    version: 59,
    name: "a2a_task_bindings",
    sql: `
      CREATE TABLE IF NOT EXISTS a2a_task_bindings (
        a2a_task_id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        session_id TEXT,
        local_task_id TEXT,
        durable_run_id TEXT,
        state TEXT NOT NULL,
        last_event_sequence BIGINT NOT NULL DEFAULT 0,
        idempotency_key TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_a2a_task_bindings_idempotency
        ON a2a_task_bindings(peer_id, idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_a2a_task_bindings_context_peer
        ON a2a_task_bindings(peer_id, context_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_a2a_task_bindings_local_task
        ON a2a_task_bindings(local_task_id);
    `,
  },
  {
    version: 60,
    name: "a2a_task_push_configs",
    sql: `
      CREATE TABLE IF NOT EXISTS a2a_task_push_configs (
        a2a_task_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        url TEXT NOT NULL,
        events_json TEXT NOT NULL DEFAULT '["task.status"]',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        auth_token TEXT,
        max_attempts BIGINT NOT NULL DEFAULT 3,
        attempt_count BIGINT NOT NULL DEFAULT 0,
        last_delivery_status TEXT NOT NULL DEFAULT 'pending',
        last_delivery_error TEXT,
        last_delivered_at TEXT,
        next_retry_at TEXT,
        last_event_sequence BIGINT NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (a2a_task_id, peer_id)
      );

      CREATE INDEX IF NOT EXISTS idx_a2a_task_push_configs_peer_updated
        ON a2a_task_push_configs(peer_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_a2a_task_push_configs_retry
        ON a2a_task_push_configs(last_delivery_status, next_retry_at);
    `,
  },
  {
    version: 61,
    name: "prompt_pack_run_score_facing_response_fields",
    sql: `
      ALTER TABLE prompt_pack_runs
        ADD COLUMN IF NOT EXISTS final_response_text TEXT,
        ADD COLUMN IF NOT EXISTS final_response_signals_json TEXT;
    `,
  },
  {
    // Applied migrations are immutable (verify:storage:migration-parity pins
    // v1-v28 by SQL hash); columns for already-shipped tables land as new
    // versions so runtimes that are past the original migration still get them.
    version: 62,
    name: "chat_delegation_step_degraded_handoff_repairs",
    sql: `
      ALTER TABLE chat_delegation_steps
        ADD COLUMN IF NOT EXISTS degraded_handoff_step_ids_json TEXT;
    `,
  },
  {
    // The Citadel tables were added to the sqlite blueprint, but Postgres only gains
    // them via the canonical runtime schema embedded at v2/v7 — already applied on
    // existing runtimes, so a runtime past v7 never created them and every Citadel route
    // 500s with `relation "citadel_charters" does not exist`. Re-running the FULL
    // canonical schema here is unsafe (it emits indexes on columns that existing tables
    // only gained via later ALTERs), so this is a TARGETED, idempotent backfill of just
    // the Citadel tables + the cron_jobs.citadel_id column the Watchtower index needs.
    // The DDL is copied verbatim from the canonical render so it matches a fresh install.
    version: 63,
    name: "citadel_tables_backfill",
    sql: `
      CREATE TABLE IF NOT EXISTS citadel_charters (
        citadel_id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        kind TEXT NOT NULL,
        goals_json TEXT NOT NULL DEFAULT '[]',
        boundaries_json TEXT NOT NULL DEFAULT '[]',
        success_definition_json TEXT NOT NULL DEFAULT '[]',
        default_chamber_id TEXT,
        risk_posture TEXT NOT NULL DEFAULT 'balanced',
        model_policy_default TEXT NOT NULL DEFAULT 'hybrid_guarded',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS citadel_chambers (
        chamber_id TEXT PRIMARY KEY,
        citadel_id TEXT NOT NULL,
        name TEXT NOT NULL,
        sensitivity TEXT NOT NULL DEFAULT 'private',
        sealed BIGINT NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS citadel_agent_assignments (
        assignment_id TEXT PRIMARY KEY,
        citadel_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS citadel_wards (
        ward_id TEXT PRIMARY KEY,
        citadel_id TEXT NOT NULL,
        name TEXT NOT NULL,
        action_pattern TEXT NOT NULL,
        effect TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS citadel_passages (
        passage_id TEXT PRIMARY KEY,
        source_citadel_id TEXT NOT NULL,
        source_chamber_id TEXT,
        destination_citadel_id TEXT NOT NULL,
        allowed_fields_json TEXT NOT NULL DEFAULT '[]',
        expires_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS citadel_members (
        member_id TEXT PRIMARY KEY,
        citadel_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS citadel_integration_grants (
        grant_id TEXT PRIMARY KEY,
        citadel_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        account TEXT,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        mode TEXT NOT NULL DEFAULT 'read',
        expires_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS citadel_vault_secrets (
        secret_id TEXT PRIMARY KEY,
        citadel_id TEXT NOT NULL,
        secret_name TEXT NOT NULL,
        sealed_value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mason_sessions (
        session_id TEXT PRIMARY KEY,
        answers_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'collecting',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      ALTER TABLE cron_jobs
        ADD COLUMN IF NOT EXISTS citadel_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_citadel_chambers_citadel ON citadel_chambers(citadel_id, name);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_citadel_agent_assignments_unique ON citadel_agent_assignments(citadel_id, agent_id);
      CREATE INDEX IF NOT EXISTS idx_citadel_wards_citadel ON citadel_wards(citadel_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_citadel_passages_source ON citadel_passages(source_citadel_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_citadel_members_unique ON citadel_members(citadel_id, subject_id);
      CREATE INDEX IF NOT EXISTS idx_citadel_integration_grants_citadel ON citadel_integration_grants(citadel_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_citadel_vault_secrets_citadel ON citadel_vault_secrets(citadel_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_citadel_vault_secrets_name ON citadel_vault_secrets(citadel_id, secret_name);
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_citadel ON cron_jobs(citadel_id, job_id);
      CREATE INDEX IF NOT EXISTS idx_mason_sessions_updated ON mason_sessions(updated_at);
    `,
  },
  {
    version: 64,
    name: "runtime_decision_traces_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS runtime_decision_traces (
        decision_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        workspace_id TEXT,
        session_id TEXT,
        turn_id TEXT,
        run_id TEXT,
        plan_id TEXT,
        step_id TEXT,
        tool_run_id TEXT,
        approval_id TEXT,
        task_id TEXT,
        durable_run_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_runtime_decision_traces_session_turn
        ON runtime_decision_traces(session_id, turn_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_runtime_decision_traces_run
        ON runtime_decision_traces(run_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_runtime_decision_traces_plan
        ON runtime_decision_traces(plan_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_runtime_decision_traces_approval
        ON runtime_decision_traces(approval_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_runtime_decision_traces_created
        ON runtime_decision_traces(created_at ASC);
    `,
  },
  {
    version: 65,
    name: "citadel_operating_model_parent_scope",
    sql: `
      CREATE TABLE IF NOT EXISTS citadel_records (
        citadel_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        slug TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL DEFAULT 'custom',
        lifecycle_status TEXT NOT NULL DEFAULT 'active',
        archived_at TEXT,
        default_workspace_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_citadel_records_lifecycle_updated
        ON citadel_records(lifecycle_status, updated_at DESC);

      ALTER TABLE IF EXISTS workspaces
        ADD COLUMN IF NOT EXISTS citadel_id TEXT NOT NULL DEFAULT 'personal';

      ALTER TABLE IF EXISTS runtime_decision_traces
        ADD COLUMN IF NOT EXISTS citadel_id TEXT;

      INSERT INTO citadel_records (
        citadel_id, name, description, slug, kind, lifecycle_status, archived_at,
        default_workspace_id, created_at, updated_at
      ) VALUES (
        'personal',
        'Personal',
        'Default personal operating world for private work, memory, files, agents, and projects.',
        'personal',
        'personal',
        'active',
        NULL,
        'default',
        NOW()::TEXT,
        NOW()::TEXT
      )
      ON CONFLICT (citadel_id) DO UPDATE SET
        default_workspace_id = COALESCE(citadel_records.default_workspace_id, EXCLUDED.default_workspace_id);

      INSERT INTO citadel_records (
        citadel_id, name, description, slug, kind, lifecycle_status, archived_at,
        default_workspace_id, created_at, updated_at
      ) VALUES (
        'company',
        'Company',
        'Default company operating world for shared workspaces such as Engineering, Product, Sales, Finance, HR, Legal, and Support.',
        'company',
        'company',
        'active',
        NULL,
        NULL,
        NOW()::TEXT,
        NOW()::TEXT
      )
      ON CONFLICT (citadel_id) DO NOTHING;

      WITH legacy_citadels AS (
        SELECT
          charter.citadel_id,
          COALESCE(NULLIF(BTRIM(workspace.name), ''), charter.citadel_id) AS name,
          COALESCE(
            NULLIF(
              REGEXP_REPLACE(
                LEFT(
                  REGEXP_REPLACE(
                    REGEXP_REPLACE(LOWER(BTRIM(charter.citadel_id)), '[^a-z0-9]+', '-', 'g'),
                    '(^-+|-+$)',
                    '',
                    'g'
                  ),
                  64
                ),
                '-+$',
                '',
                'g'
              ),
              ''
            ),
            'citadel'
          ) AS base_slug,
          charter.kind,
          workspace.workspace_id,
          charter.created_at,
          charter.updated_at
        FROM citadel_charters AS charter
        LEFT JOIN workspaces AS workspace
          ON workspace.workspace_id = charter.citadel_id
        WHERE NOT EXISTS (
          SELECT 1
          FROM citadel_records AS existing
          WHERE existing.citadel_id = charter.citadel_id
        )
      ),
      ranked_legacy_citadels AS (
        SELECT
          *,
          COUNT(*) OVER (PARTITION BY base_slug) AS base_slug_count,
          ROW_NUMBER() OVER (PARTITION BY base_slug ORDER BY citadel_id ASC) AS base_slug_rank
        FROM legacy_citadels
      )
      INSERT INTO citadel_records (
        citadel_id, name, description, slug, kind, lifecycle_status, archived_at,
        default_workspace_id, created_at, updated_at
      )
      SELECT
        ranked.citadel_id,
        ranked.name,
        'Legacy workspace Citadel preserved during parent-scope migration.',
        CASE
          WHEN ranked.base_slug_count > 1
            OR EXISTS (SELECT 1 FROM citadel_records existing_slug WHERE existing_slug.slug = ranked.base_slug)
          THEN
            REGEXP_REPLACE(
              LEFT(ranked.base_slug, GREATEST(1, 64 - LENGTH('-' || ranked.base_slug_rank::TEXT))),
              '-+$',
              '',
              'g'
            ) || '-' || ranked.base_slug_rank::TEXT
          ELSE ranked.base_slug
        END,
        ranked.kind,
        'active',
        NULL,
        ranked.workspace_id,
        ranked.created_at,
        ranked.updated_at
      FROM ranked_legacy_citadels AS ranked
      ON CONFLICT (citadel_id) DO NOTHING;

      UPDATE workspaces
      SET citadel_id = 'personal'
      WHERE citadel_id IS NULL OR BTRIM(citadel_id) = '';

      UPDATE workspaces
      SET citadel_id = workspace_id
      WHERE EXISTS (
        SELECT 1
        FROM citadel_records
        WHERE citadel_records.citadel_id = workspaces.workspace_id
          AND citadel_records.citadel_id NOT IN ('personal', 'company')
      );

      CREATE INDEX IF NOT EXISTS idx_workspaces_citadel_updated
        ON workspaces(citadel_id, lifecycle_status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runtime_decision_traces_citadel_created
        ON runtime_decision_traces(citadel_id, created_at ASC);
    `,
  },
  {
    version: 66,
    name: "external_connector_review_states",
    sql: `
      CREATE TABLE IF NOT EXISTS external_connector_review_states (
        workspace_id TEXT NOT NULL DEFAULT 'default',
        source_id TEXT NOT NULL,
        service_id TEXT NOT NULL,
        action_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        proposal_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, source_id, service_id, action_id)
      );

      CREATE INDEX IF NOT EXISTS idx_external_connector_review_states_workspace
        ON external_connector_review_states(workspace_id, status, pinned, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_external_connector_review_states_service
        ON external_connector_review_states(source_id, service_id, action_id);
    `,
  },
  {
    version: 67,
    name: "cost_ledger_credential_pool",
    sql: `
      ALTER TABLE cost_ledger
        ADD COLUMN IF NOT EXISTS credential_type TEXT,
        ADD COLUMN IF NOT EXISTS usage_pool TEXT;
    `,
  },
  {
    version: 68,
    name: "runtime_evidence_workspace_scope",
    sql: `
      ALTER TABLE runtime_evidence_envelopes
        ADD COLUMN IF NOT EXISTS workspace_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_runtime_evidence_workspace_created
        ON runtime_evidence_envelopes(workspace_id, created_at DESC);
    `,
  },
  {
    version: 69,
    name: "autonomy_audit_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS autonomy_audit (
        audit_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        target_key TEXT NOT NULL DEFAULT '',
        occurred_at TEXT NOT NULL,
        restore_ref_json TEXT NOT NULL DEFAULT '{}',
        reverted INTEGER NOT NULL DEFAULT 0,
        reverted_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_autonomy_audit_since
        ON autonomy_audit(occurred_at);

      CREATE INDEX IF NOT EXISTS idx_autonomy_audit_unreverted
        ON autonomy_audit(reverted, occurred_at);
    `,
  },
  {
    version: 70,
    name: "chat_delegation_parent_run_id",
    sql: `
      ALTER TABLE chat_delegation_runs
        ADD COLUMN IF NOT EXISTS parent_run_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_chat_delegation_runs_parent
        ON chat_delegation_runs(parent_run_id, started_at DESC);
    `,
  },
  {
    version: 71,
    name: "session_autonomy_heartbeat_prefs",
    sql: `
      ALTER TABLE IF EXISTS session_autonomy_prefs
        ADD COLUMN IF NOT EXISTS heartbeat_enabled BIGINT NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS heartbeat_interval_seconds BIGINT NOT NULL DEFAULT 3600,
        ADD COLUMN IF NOT EXISTS active_hours_json TEXT;
    `,
  },
  {
    version: 72,
    name: "operator_memory_commitment_runtime_backfill",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_items (
        item_id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        pinned BIGINT NOT NULL DEFAULT 0,
        ttl_override_seconds BIGINT,
        expires_at TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        forgotten_at TEXT,
        workspace_id TEXT
      );

      ALTER TABLE IF EXISTS memory_items
        ADD COLUMN IF NOT EXISTS workspace_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_memory_items_namespace_status
        ON memory_items(namespace, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_items_pinned_updated
        ON memory_items(pinned DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_items_workspace
        ON memory_items(workspace_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS agent_commitments (
        commitment_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        kind TEXT NOT NULL,
        due_at TEXT NOT NULL,
        confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
        dedupe_key TEXT NOT NULL,
        suggested_text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_by TEXT NOT NULL DEFAULT 'classifier',
        created_at TEXT NOT NULL,
        sent_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_commitments_session_dedupe
        ON agent_commitments(session_id, dedupe_key);
      CREATE INDEX IF NOT EXISTS idx_agent_commitments_status_due
        ON agent_commitments(status, due_at);

      CREATE TABLE IF NOT EXISTS operator_profiles (
        operator_profile_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        summary TEXT NOT NULL DEFAULT '',
        facts_json TEXT NOT NULL DEFAULT '[]',
        revision BIGINT NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_profiles_workspace
        ON operator_profiles(workspace_id);
    `,
  },
  {
    version: 73,
    name: "capability_scope_assignments",
    sql: `
      CREATE TABLE IF NOT EXISTS capability_scope_assignments (
        assignment_id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_ref TEXT NOT NULL,
        enabled BIGINT NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_scope_assignments_unique
        ON capability_scope_assignments(scope_kind, scope_id, resource_type, resource_ref);

      CREATE INDEX IF NOT EXISTS idx_capability_scope_assignments_lookup
        ON capability_scope_assignments(scope_kind, scope_id, resource_type, enabled);
    `,
  },
  {
    version: 74,
    name: "chat_messages_content_search_vector",
    sql: `
      ALTER TABLE chat_messages
        ADD COLUMN IF NOT EXISTS content_search_vector tsvector
        GENERATED ALWAYS AS (to_tsvector('simple', COALESCE(content, ''))) STORED;

      CREATE INDEX IF NOT EXISTS idx_chat_messages_content_search_vector
        ON chat_messages USING GIN (content_search_vector);

      CREATE INDEX IF NOT EXISTS idx_chat_messages_session_seq
        ON chat_messages(session_id, seq DESC);
    `,
  },
  {
    version: 75,
    name: "cron_jobs_run_evidence_state",
    sql: `
      ALTER TABLE cron_jobs
        ADD COLUMN IF NOT EXISTS last_run_status TEXT,
        ADD COLUMN IF NOT EXISTS last_run_evidence_envelope_id TEXT,
        ADD COLUMN IF NOT EXISTS last_failure_at TEXT,
        ADD COLUMN IF NOT EXISTS last_failure_json TEXT,
        ADD COLUMN IF NOT EXISTS failure_count BIGINT,
        ADD COLUMN IF NOT EXISTS backoff_until TEXT;
    `,
  },
  {
    version: 76,
    name: "integration_connections_workspace_scope_parity",
    sql: `
      ALTER TABLE integration_connections
        ADD COLUMN IF NOT EXISTS workspace_id TEXT;
    `,
  },
  {
    version: 77,
    name: "dry_run_commits_ledger_parity",
    sql: `
      CREATE TABLE IF NOT EXISTS dry_run_commits (
        dry_run_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        boundary TEXT NOT NULL,
        workspace_id TEXT,
        planned_action_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        dry_run_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        approved_at TEXT,
        approved_by TEXT,
        committed_at TEXT,
        diagnostic_json TEXT,
        external_reference_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dry_run_commits_run
        ON dry_run_commits(run_id);
      CREATE INDEX IF NOT EXISTS idx_dry_run_commits_state_created
        ON dry_run_commits(state, created_at DESC);
    `,
  },
  {
    version: 78,
    name: "prompt_packs_content_sha256",
    sql: `
      ALTER TABLE prompt_packs
        ADD COLUMN IF NOT EXISTS content_sha256 TEXT;
    `,
  },
  {
    version: 79,
    name: "scrub_legacy_device_token_plaintext",
    sql: `
      UPDATE auth_device_grants AS device_grant
      SET revoked_at = COALESCE(
        device_grant.revoked_at,
        to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      FROM auth_device_requests AS request
      WHERE device_grant.request_id = request.request_id
        AND device_grant.revoked_at IS NULL
        AND request.approved_token_plaintext IS NOT NULL
        AND btrim(request.approved_token_plaintext) <> ''
        AND request.delivered_at IS NULL;

      UPDATE auth_device_requests
      SET status = CASE
            WHEN approved_token_plaintext IS NOT NULL
              AND btrim(approved_token_plaintext) <> ''
              AND delivered_at IS NULL
            THEN 'expired'
            ELSE status
          END,
          resolution_note = CASE
            WHEN approved_token_plaintext IS NOT NULL
              AND btrim(approved_token_plaintext) <> ''
              AND delivered_at IS NULL
            THEN COALESCE(
              NULLIF(btrim(resolution_note), ''),
              'Legacy device credential was revoked because its plaintext handoff predated secure in-memory delivery. Request access again.'
            )
            ELSE resolution_note
          END,
          approved_token_expires_at = CASE
            WHEN approved_token_plaintext IS NOT NULL
              AND btrim(approved_token_plaintext) <> ''
              AND delivered_at IS NULL
            THEN NULL
            ELSE approved_token_expires_at
          END,
          approved_token_plaintext = NULL
      WHERE approved_token_plaintext IS NOT NULL;
    `,
  },
  {
    version: 80,
    name: "approval_expiry_sweep_index_parity",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_approvals_status_expires_at
        ON approvals(status, expires_at_ts ASC, approval_id ASC)
      WHERE expires_at_ts IS NOT NULL;
    `,
  },
  {
    version: 81,
    name: "scrub_legacy_remote_approval_bearers",
    sql: "",
    integritySha256: "4187b1a0cc73330480192ee66650990775c53c35fe2c54a01559ab4af6631b0a",
    batchedStatements: [
      {
        name: "fail_active_durable_connector_deliveries",
        sql: buildPostgresV81BoundedUpdate({
          table: "durable_runs",
          keyColumns: ["run_id"],
          predicate: [
            "workflow_key = 'connector.delivery'",
            postgresV81BearerMatch("payload_json"),
            "status IN ('queued', 'running', 'waiting', 'paused')",
          ].join("\n        AND "),
          assignments: `status = 'failed',
        finished_at = COALESCE(
          finished_at,
          to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ),
        last_error = COALESCE(
          last_error,
          'Legacy remote approval bearer was removed from durable state; issue a new remote action token.'
        ),
        lease_owner_id = NULL,
        lease_expires_at = NULL,
        lease_heartbeat_at = NULL,
        updated_at = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        version = version + 1`,
        }),
      },
      {
        name: "fail_active_comms_deliveries",
        sql: buildPostgresV81BoundedUpdate({
          table: "comms_deliveries",
          keyColumns: ["delivery_id"],
          predicate: [postgresV81BearerMatch("payload_json"), "status IN ('queued', 'running', 'retrying')"].join(
            "\n        AND ",
          ),
          assignments: `status = 'failed',
        delivery_status = 'manual_reconciliation_required',
        next_attempt_at = NULL,
        error = COALESCE(
          error,
          'Legacy remote approval bearer was removed before delivery; issue a new remote action token.'
        ),
        updated_at = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        }),
      },
      {
        name: "scrub_durable_runs",
        sql: buildPostgresV81BoundedUpdate({
          table: "durable_runs",
          keyColumns: ["run_id"],
          predicate: postgresV81BearerPredicate(["payload_json", "metadata_json", "last_error"]),
          assignments: postgresV81RedactAssignments(["payload_json", "metadata_json", "last_error"]),
        }),
      },
      {
        name: "scrub_durable_checkpoints",
        sql: buildPostgresV81BoundedUpdate({
          table: "durable_checkpoints",
          keyColumns: ["checkpoint_id"],
          predicate: postgresV81BearerPredicate(["state_json"]),
          assignments: postgresV81RedactAssignments(["state_json"]),
        }),
      },
      {
        name: "scrub_durable_run_events",
        sql: buildPostgresV81BoundedUpdate({
          table: "durable_run_events",
          keyColumns: ["event_id"],
          predicate: postgresV81BearerPredicate(["payload_json"]),
          assignments: postgresV81RedactAssignments(["payload_json"]),
        }),
      },
      {
        name: "scrub_comms_deliveries",
        sql: buildPostgresV81BoundedUpdate({
          table: "comms_deliveries",
          keyColumns: ["delivery_id"],
          predicate: postgresV81BearerPredicate(["payload_json", "error", "stale_reason"]),
          assignments: postgresV81RedactAssignments(["payload_json", "error", "stale_reason"]),
        }),
      },
      {
        name: "scrub_realtime_events",
        sql: buildPostgresV81BoundedUpdate({
          table: "realtime_events",
          keyColumns: ["event_id"],
          predicate: postgresV81BearerPredicate(["payload_json"]),
          assignments: postgresV81RedactAssignments(["payload_json"]),
        }),
      },
      {
        name: "scrub_approval_inbox_items",
        sql: buildPostgresV81BoundedUpdate({
          table: "approval_inbox_items",
          keyColumns: ["inbox_item_id"],
          predicate: postgresV81BearerMatch("token"),
          assignments: "token = 'redacted:' || token_id",
        }),
      },
      {
        name: "scrub_approval_events",
        sql: buildPostgresV81BoundedUpdate({
          table: "approval_events",
          keyColumns: ["event_id"],
          predicate: postgresV81BearerPredicate(["payload_json"]),
          assignments: postgresV81RedactAssignments(["payload_json"]),
        }),
      },
      {
        name: "scrub_approvals",
        sql: buildPostgresV81BoundedUpdate({
          table: "approvals",
          keyColumns: ["approval_id"],
          predicate: postgresV81BearerPredicate([
            "linkage_json",
            "payload_json",
            "preview_json",
            "explanation_json",
            "explanation_error",
            "resolution_note",
            "shell_explanations_json",
          ]),
          assignments: postgresV81RedactAssignments([
            "linkage_json",
            "payload_json",
            "preview_json",
            "explanation_json",
            "explanation_error",
            "resolution_note",
            "shell_explanations_json",
          ]),
        }),
      },
      {
        name: "scrub_pending_approval_actions",
        sql: buildPostgresV81BoundedUpdate({
          table: "pending_approval_actions",
          keyColumns: ["approval_id"],
          predicate: postgresV81BearerPredicate(["request_json", "result_json"]),
          assignments: postgresV81RedactAssignments(["request_json", "result_json"]),
        }),
      },
      {
        name: "scrub_tool_invocations",
        sql: buildPostgresV81BoundedUpdate({
          table: "tool_invocations",
          keyColumns: ["audit_event_id"],
          predicate: postgresV81BearerPredicate(["args_json", "result_json", "policy_reason"]),
          assignments: postgresV81RedactAssignments(["args_json", "result_json", "policy_reason"]),
        }),
      },
      {
        name: "scrub_policy_blocks",
        sql: buildPostgresV81BoundedUpdate({
          table: "policy_blocks",
          keyColumns: ["audit_event_id"],
          predicate: postgresV81BearerPredicate(["details_json", "reason"]),
          assignments: postgresV81RedactAssignments(["details_json", "reason"]),
        }),
      },
      {
        name: "scrub_approval_effects",
        sql: buildPostgresV81BoundedUpdate({
          table: "approval_effects",
          keyColumns: ["effect_id"],
          predicate: postgresV81BearerPredicate(["payload_json", "last_error"]),
          assignments: postgresV81RedactAssignments(["payload_json", "last_error"]),
        }),
      },
      {
        name: "scrub_external_side_effect_runs",
        sql: buildPostgresV81BoundedUpdate({
          table: "external_side_effect_runs",
          keyColumns: ["run_id"],
          predicate: postgresV81BearerPredicate(["request_payload_json", "response_payload_json", "error_text"]),
          assignments: postgresV81RedactAssignments(["request_payload_json", "response_payload_json", "error_text"]),
        }),
      },
      {
        name: "scrub_runtime_decision_traces",
        sql: buildPostgresV81BoundedUpdate({
          table: "runtime_decision_traces",
          keyColumns: ["decision_id"],
          predicate: postgresV81BearerPredicate(["payload_json"]),
          assignments: postgresV81RedactAssignments(["payload_json"]),
        }),
      },
      {
        name: "scrub_audit_events",
        sql: buildPostgresV81BoundedUpdate({
          table: "audit_events",
          keyColumns: ["stream_name", "event_id"],
          predicate: postgresV81BearerMatch("payload::text"),
          assignments: `payload = regexp_replace(
          payload::text,
          '${POSTGRES_V81_REMOTE_APPROVAL_BEARER_PATTERN}',
          '[REDACTED]',
          'g'
        )::jsonb`,
        }),
      },
    ],
  },
  {
    version: 82,
    name: "mutation_idempotency_claim_lease_parity",
    sql: `
      ALTER TABLE mutation_idempotency
        ADD COLUMN IF NOT EXISTS claim_token TEXT,
        ADD COLUMN IF NOT EXISTS claim_expires_at TEXT;

      UPDATE mutation_idempotency
      SET claim_token = COALESCE(
            claim_token,
            'legacy-' || md5(method || route_path || idempotency_key || actor_scope || random()::text)
          ),
          claim_expires_at = COALESCE(claim_expires_at, updated_at)
      WHERE status = 'pending';

      CREATE INDEX IF NOT EXISTS idx_mutation_idempotency_pending_lease
        ON mutation_idempotency(status, claim_expires_at, updated_at);
    `,
  },
  {
    version: 83,
    name: "chat_delegation_step_plan_truth",
    sql: `
      ALTER TABLE chat_delegation_steps
        ADD COLUMN IF NOT EXISTS parallelizable BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS depends_on_step_ids_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 84,
    name: "chat_delegation_dispatch_claim_lease",
    sql: `
      ALTER TABLE chat_delegation_steps
        ADD COLUMN IF NOT EXISTS dispatch_claim_token TEXT,
        ADD COLUMN IF NOT EXISTS dispatch_claim_expires_at TEXT;

      UPDATE chat_delegation_steps
      SET dispatch_claim_token = child_session_id,
          dispatch_claim_expires_at = CASE
            WHEN child_session_id ~ '^delegation-claim:v1:[0-9]+:' THEN
              to_char(
                to_timestamp(
                  substring(child_session_id from '^delegation-claim:v1:([0-9]+):')::double precision / 1000.0
                ) AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )
            ELSE '1970-01-01T00:00:00.000Z'
          END,
          child_session_id = NULL
      WHERE child_session_id LIKE 'delegation-claim:v1:%';

      UPDATE chat_delegation_steps
      SET dispatch_claim_token = child_turn_id,
          dispatch_claim_expires_at = CASE
            WHEN child_turn_id ~ '^delegation-dispatch:v1:[0-9]+:' THEN
              to_char(
                to_timestamp(
                  substring(child_turn_id from '^delegation-dispatch:v1:([0-9]+):')::double precision / 1000.0
                ) AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )
            ELSE '1970-01-01T00:00:00.000Z'
          END,
          child_turn_id = NULL
      WHERE child_turn_id LIKE 'delegation-dispatch:v1:%';

      CREATE INDEX IF NOT EXISTS idx_chat_delegation_steps_dispatch_claim
        ON chat_delegation_steps(status, dispatch_claim_expires_at, step_id);
    `,
  },
  {
    version: 85,
    name: "scrub_legacy_remote_approval_bearers_from_effect_results",
    sql: "",
    integritySha256: "ef8cc376dbcba14eb6dd496d5cf14be19183096bafcab2ae57395dedae76df74",
    batchedStatements: [
      {
        name: "scrub_approval_effect_results",
        sql: buildPostgresV81BoundedUpdate({
          table: "approval_effects",
          keyColumns: ["effect_id"],
          predicate: postgresV81BearerPredicate(["result_json", "detail", "details_json", "outcome"]),
          assignments: postgresV81RedactAssignments(["result_json", "detail", "details_json", "outcome"]),
        }),
      },
    ],
  },
  {
    version: 86,
    name: "orchestration_worktree_generation_leases",
    sql: `
      ALTER TABLE orchestration_runs
        ADD COLUMN IF NOT EXISTS worktree_lease_owner_id TEXT,
        ADD COLUMN IF NOT EXISTS worktree_lease_generation BIGINT,
        ADD COLUMN IF NOT EXISTS worktree_lease_expires_at TEXT;

      CREATE TABLE IF NOT EXISTS orchestration_worktree_leases (
        worktree_path TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        generation BIGINT NOT NULL DEFAULT 1,
        lease_expires_at TEXT NOT NULL,
        released_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_orchestration_worktree_leases_run
        ON orchestration_worktree_leases(run_id, generation DESC);
      CREATE INDEX IF NOT EXISTS idx_orchestration_worktree_leases_expiry
        ON orchestration_worktree_leases(released_at, lease_expires_at);
    `,
  },
  {
    version: 87,
    name: "operator_resource_revision_cas_foundation",
    sql: `
      ALTER TABLE workspaces
        ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;
      ALTER TABLE chat_projects
        ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 88,
    name: "chat_session_aggregate_revision_cas",
    sql: `
      ALTER TABLE chat_session_meta
        ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 89,
    name: "cron_job_spec_revision_cas",
    sql: `
      ALTER TABLE cron_jobs
        ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 90,
    name: "task_resource_revision_cas",
    sql: `
      ALTER TABLE tasks
        ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 91,
    name: "channel_acceptance_and_cron_run_durability",
    sql: `
      ALTER TABLE cron_jobs
        ADD COLUMN IF NOT EXISTS execution_generation BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS active_run_id TEXT;

      CREATE TABLE IF NOT EXISTS inbound_channel_events (
        sequence BIGSERIAL PRIMARY KEY,
        event_id TEXT NOT NULL,
        channel_key TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        transport TEXT NOT NULL,
        dispatch_kind TEXT NOT NULL,
        provider_source_id TEXT,
        idempotency_key TEXT NOT NULL,
        lane_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'accepted',
        attempt_count BIGINT NOT NULL DEFAULT 0,
        claim_generation BIGINT NOT NULL DEFAULT 0,
        claim_token TEXT,
        claim_owner_id TEXT,
        claim_expires_at TEXT,
        claim_heartbeat_at TEXT,
        next_attempt_at TEXT,
        session_key TEXT,
        session_id TEXT,
        message_id TEXT,
        turn_id TEXT,
        assistant_message_id TEXT,
        durable_run_id TEXT,
        delivery_id TEXT,
        provider_message_id TEXT,
        message_content_hash TEXT,
        delivery_payload_hash TEXT,
        last_error TEXT,
        reconciliation_reason TEXT,
        received_at TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_channel_events_event_id
        ON inbound_channel_events(event_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_channel_events_identity
        ON inbound_channel_events(channel_key, connection_id, idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_inbound_channel_events_due
        ON inbound_channel_events(status, next_attempt_at, claim_expires_at, sequence);
      CREATE INDEX IF NOT EXISTS idx_inbound_channel_events_lane
        ON inbound_channel_events(channel_key, connection_id, lane_key, sequence);
      CREATE INDEX IF NOT EXISTS idx_inbound_channel_events_session
        ON inbound_channel_events(session_id, sequence);

      CREATE TABLE IF NOT EXISTS cron_runs (
        run_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        admission_key TEXT NOT NULL,
        execution_generation BIGINT NOT NULL,
        trigger_kind TEXT NOT NULL,
        job_revision BIGINT NOT NULL,
        action TEXT NOT NULL,
        action_snapshot_json TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'admitting',
        phase TEXT NOT NULL DEFAULT 'child_admission',
        child_session_id TEXT,
        child_message_id TEXT,
        child_turn_id TEXT,
        child_assistant_message_id TEXT,
        child_durable_run_id TEXT,
        delivery_run_id TEXT,
        external_side_effect_run_id TEXT,
        evidence_envelope_id TEXT,
        outcome_json TEXT,
        failure_json TEXT,
        reconciliation_reason TEXT,
        reconciliation_resolution TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        admitted_at TEXT,
        started_at TEXT,
        settled_at TEXT,
        reconciled_at TEXT,
        reconciled_by TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_runs_admission
        ON cron_runs(job_id, admission_key);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_runs_job_generation
        ON cron_runs(job_id, execution_generation);
      CREATE INDEX IF NOT EXISTS idx_cron_runs_job_created
        ON cron_runs(job_id, created_at DESC, run_id);
      CREATE INDEX IF NOT EXISTS idx_cron_runs_status_scheduled
        ON cron_runs(status, scheduled_for, run_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_runs_child_durable
        ON cron_runs(child_durable_run_id)
        WHERE child_durable_run_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_runs_evidence
        ON cron_runs(evidence_envelope_id)
        WHERE evidence_envelope_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_cron_runs_pending_settlement
        ON cron_runs(status, phase, updated_at, run_id)
        WHERE status IN ('admitting', 'admitted', 'running', 'waiting');
      CREATE INDEX IF NOT EXISTS idx_cron_runs_reconciliation
        ON cron_runs(reconciled_at, updated_at, run_id)
        WHERE status = 'manual_reconciliation_required';
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_active_run
        ON cron_jobs(active_run_id, execution_generation);
    `,
  },
  {
    version: 92,
    name: "inbound_channel_admission_settlement",
    sql: `
      ALTER TABLE inbound_channel_events
        ADD COLUMN IF NOT EXISTS bot_loop_decision TEXT,
        ADD COLUMN IF NOT EXISTS bot_loop_reason TEXT,
        ADD COLUMN IF NOT EXISTS command_operation_key TEXT,
        ADD COLUMN IF NOT EXISTS command_result_text TEXT;
    `,
  },
  {
    version: 93,
    name: "code_mode_verification_ledger",
    sql: `
      ALTER TABLE code_mode_runs
        ADD COLUMN IF NOT EXISTS trusted_code_write_verification_json TEXT,
        ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'not_applicable',
        ADD COLUMN IF NOT EXISTS verification_evidence_id TEXT,
        ADD COLUMN IF NOT EXISTS verification_subject_hash TEXT,
        ADD COLUMN IF NOT EXISTS verification_reason TEXT,
        ADD COLUMN IF NOT EXISTS verification_updated_at TEXT;

      UPDATE code_mode_runs
      SET verification_status = CASE
            WHEN status = 'completed' THEN 'completed_unverified'
            ELSE 'not_applicable'
          END,
          verification_updated_at = COALESCE(finished_at, started_at, created_at)
      WHERE verification_evidence_id IS NULL;

      CREATE TABLE IF NOT EXISTS code_mode_verification_evidence (
        sequence BIGSERIAL PRIMARY KEY,
        evidence_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES code_mode_runs(run_id),
        status TEXT NOT NULL,
        subject_hash TEXT NOT NULL,
        command_name TEXT NOT NULL,
        command_label TEXT NOT NULL,
        scope TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_code_mode_verification_evidence_run
        ON code_mode_verification_evidence(run_id, sequence DESC);

      CREATE OR REPLACE FUNCTION reject_code_mode_verification_evidence_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $code_mode_verification_ledger$
      BEGIN
        RAISE EXCEPTION 'code_mode_verification_evidence is append-only';
      END;
      $code_mode_verification_ledger$;

      DROP TRIGGER IF EXISTS reject_code_mode_verification_evidence_mutation
        ON code_mode_verification_evidence;
      CREATE TRIGGER reject_code_mode_verification_evidence_mutation
        BEFORE UPDATE OR DELETE ON code_mode_verification_evidence
        FOR EACH ROW
        EXECUTE FUNCTION reject_code_mode_verification_evidence_mutation();
    `,
  },
  {
    version: 94,
    name: "durable_child_watchers",
    sql: `
      ALTER TABLE durable_run_events
        ADD COLUMN IF NOT EXISTS sequence BIGINT;

      WITH ranked AS (
        SELECT
          event_id,
          ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY created_at ASC, event_id ASC) AS run_sequence
        FROM durable_run_events
      )
      UPDATE durable_run_events AS events
      SET sequence = ranked.run_sequence
      FROM ranked
      WHERE events.event_id = ranked.event_id
        AND events.sequence IS NULL;

      ALTER TABLE durable_run_events
        ALTER COLUMN sequence SET NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_run_events_run_sequence
        ON durable_run_events(run_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_durable_run_events_run_sequence_scan
        ON durable_run_events(run_id, sequence ASC);

      CREATE TABLE IF NOT EXISTS durable_run_event_sequences (
        run_id TEXT PRIMARY KEY REFERENCES durable_runs(run_id) ON DELETE CASCADE,
        last_sequence BIGINT NOT NULL
      );

      INSERT INTO durable_run_event_sequences (run_id, last_sequence)
      SELECT run_id, MAX(sequence)
      FROM durable_run_events
      GROUP BY run_id
      ON CONFLICT(run_id) DO UPDATE SET
        last_sequence = GREATEST(durable_run_event_sequences.last_sequence, EXCLUDED.last_sequence);

      CREATE TABLE IF NOT EXISTS durable_child_watcher_scan_state (
        scan_key TEXT PRIMARY KEY,
        last_watcher_id TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      INSERT INTO durable_child_watcher_scan_state (scan_key, last_watcher_id, updated_at)
      VALUES ('global', '', '1970-01-01T00:00:00.000Z')
      ON CONFLICT(scan_key) DO NOTHING;

      CREATE TABLE IF NOT EXISTS durable_child_watchers (
        watcher_id TEXT PRIMARY KEY,
        parent_run_id TEXT NOT NULL REFERENCES durable_runs(run_id) ON DELETE CASCADE,
        child_run_id TEXT NOT NULL REFERENCES durable_runs(run_id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'attached'
          CHECK(state IN ('attached', 'detached', 'closed')),
        next_sequence BIGINT NOT NULL DEFAULT 1,
        last_consumed_sequence BIGINT NOT NULL DEFAULT 0,
        projected_notice_count BIGINT NOT NULL DEFAULT 0,
        source TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        detached_at TEXT,
        reattached_at TEXT,
        closed_at TEXT,
        UNIQUE(parent_run_id, child_run_id),
        CHECK(parent_run_id <> child_run_id),
        CHECK(next_sequence = last_consumed_sequence + 1)
      );

      CREATE INDEX IF NOT EXISTS idx_durable_child_watchers_parent
        ON durable_child_watchers(parent_run_id, state, created_at, watcher_id);
      CREATE INDEX IF NOT EXISTS idx_durable_child_watchers_child_attached
        ON durable_child_watchers(child_run_id, state, watcher_id);
    `,
  },
  {
    version: 95,
    name: "code_mode_interruption_recovery",
    sql: `
      ALTER TABLE code_mode_runs
        ADD COLUMN IF NOT EXISTS execution_generation BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS execution_phase TEXT NOT NULL DEFAULT 'legacy_unknown',
        ADD COLUMN IF NOT EXISTS recovery_disposition TEXT NOT NULL DEFAULT 'none',
        ADD COLUMN IF NOT EXISTS execution_boundary_crossed_at TEXT,
        ADD COLUMN IF NOT EXISTS interrupted_at TEXT,
        ADD COLUMN IF NOT EXISTS interruption_reason TEXT,
        ADD COLUMN IF NOT EXISTS final_transcript_event_id TEXT,
        ADD COLUMN IF NOT EXISTS final_transcript_enqueued_at TEXT;

      UPDATE code_mode_runs
      SET execution_phase = CASE
            WHEN status IN ('completed', 'failed', 'rejected', 'expired') THEN 'terminal'
            WHEN status IN ('approval_pending', 'queued') THEN 'not_started'
            ELSE 'legacy_unknown'
          END,
          recovery_disposition = CASE
            WHEN status IN ('completed', 'failed', 'rejected', 'expired') THEN 'terminal'
            WHEN status = 'running' THEN 'manual_reconciliation'
            ELSE 'none'
          END,
          final_transcript_event_id = CASE
            WHEN session_id IS NOT NULL AND BTRIM(session_id) <> ''
            THEN 'code-mode-final:' || run_id
            ELSE final_transcript_event_id
          END;

      CREATE INDEX IF NOT EXISTS idx_code_mode_runs_pending_final_transcript
        ON code_mode_runs(finished_at, run_id)
        WHERE session_id IS NOT NULL
          AND status IN ('completed', 'failed')
          AND final_transcript_enqueued_at IS NULL;
    `,
  },
  {
    version: 96,
    name: "chat_turn_capability_profiles",
    sql: `
      ALTER TABLE chat_turn_traces
        ADD COLUMN IF NOT EXISTS capability_snapshot_id TEXT,
        ADD COLUMN IF NOT EXISTS capability_profile_id TEXT,
        ADD COLUMN IF NOT EXISTS capability_profile_hash TEXT;

      CREATE TABLE IF NOT EXISTS chat_turn_capability_profiles (
        profile_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        durable_run_id TEXT UNIQUE,
        operator_id TEXT,
        auth_actor_id TEXT,
        schema_version TEXT NOT NULL,
        profile_hash TEXT NOT NULL,
        catalog_snapshot_id TEXT NOT NULL,
        inspectable_hash TEXT NOT NULL,
        callable_hash TEXT NOT NULL,
        selection_hash TEXT NOT NULL,
        governance_hash TEXT NOT NULL,
        preflight_fingerprint TEXT NOT NULL,
        profile_json TEXT NOT NULL CHECK(octet_length(profile_json) <= 524288),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_turn_capability_profiles_session_created
        ON chat_turn_capability_profiles(session_id, created_at, profile_id);
      CREATE INDEX IF NOT EXISTS idx_chat_turn_capability_profiles_workspace_created
        ON chat_turn_capability_profiles(workspace_id, created_at, profile_id);

      CREATE OR REPLACE FUNCTION gc_reject_chat_turn_capability_profile_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'chat turn capability profiles are immutable';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_chat_turn_capability_profiles_no_update ON chat_turn_capability_profiles;
      CREATE TRIGGER trg_chat_turn_capability_profiles_no_update
        BEFORE UPDATE ON chat_turn_capability_profiles
        FOR EACH ROW EXECUTE FUNCTION gc_reject_chat_turn_capability_profile_mutation();

      DROP TRIGGER IF EXISTS trg_chat_turn_capability_profiles_no_delete ON chat_turn_capability_profiles;
      CREATE TRIGGER trg_chat_turn_capability_profiles_no_delete
        BEFORE DELETE ON chat_turn_capability_profiles
        FOR EACH ROW EXECUTE FUNCTION gc_reject_chat_turn_capability_profile_mutation();
    `,
  },
  {
    version: 97,
    name: "chat_compaction_hysteresis_state",
    sql: `
      ALTER TABLE chat_conversation_summaries
        ADD COLUMN IF NOT EXISTS window_key TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_conversation_summaries_window_key
        ON chat_conversation_summaries(window_key)
        WHERE window_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS chat_compaction_states (
        state_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        dimension_hash TEXT NOT NULL,
        provider_id TEXT,
        model TEXT,
        profile_fingerprint TEXT,
        boundary_turn_ids_json TEXT NOT NULL CHECK(octet_length(boundary_turn_ids_json) <= 131072),
        boundary_source_hash TEXT NOT NULL,
        baseline_input_tokens BIGINT NOT NULL,
        last_observed_input_tokens BIGINT NOT NULL,
        observed_turn_count BIGINT NOT NULL,
        armed BIGINT NOT NULL CHECK(armed IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_compaction_states_session_dimension
        ON chat_compaction_states(session_id, dimension_hash, observed_turn_count DESC, updated_at DESC);
    `,
  },
  {
    version: 98,
    name: "durable_child_watcher_revision_cas",
    sql: `
      ALTER TABLE durable_child_watchers
        ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;

      ALTER TABLE durable_child_watchers
        DROP CONSTRAINT IF EXISTS durable_child_watchers_revision_positive;
      ALTER TABLE durable_child_watchers
        ADD CONSTRAINT durable_child_watchers_revision_positive CHECK(revision >= 1);
    `,
  },
  {
    version: 99,
    name: "chat_tool_effect_truth",
    sql: `
      ALTER TABLE chat_tool_runs
        ADD COLUMN IF NOT EXISTS effect_potential TEXT,
        ADD COLUMN IF NOT EXISTS effect_disposition TEXT,
        ADD COLUMN IF NOT EXISTS effect_outcome_kind TEXT,
        ADD COLUMN IF NOT EXISTS effect_evidence_json TEXT;
    `,
  },
  {
    version: 100,
    name: "model_usage_events",
    sql: `
      CREATE TABLE IF NOT EXISTS model_usage_events (
        event_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL CHECK(source IN ('llm_service', 'embedding_runtime', 'manual_test')),
        call_kind TEXT NOT NULL,
        requested_provider_id TEXT,
        requested_model_id TEXT,
        requested_reasoning_level TEXT,
        dispatched_reasoning_effort TEXT,
        reasoning_disposition TEXT
          CHECK(reasoning_disposition IS NULL OR reasoning_disposition IN (
            'honored', 'downgraded', 'unsupported_blocked', 'provider_default'
          )),
        reasoning_reason_code TEXT,
        dispatched_model_id TEXT,
        effective_provider_id TEXT,
        effective_model_id TEXT,
        effective_api_style TEXT,
        route_decision_id TEXT,
        context_snapshot_id TEXT,
        context_intent_hash TEXT,
        context_entry_ref_id TEXT,
        context_resolution_hash TEXT,
        operation_id TEXT NOT NULL,
        parent_operation_id TEXT,
        dispatch_generation TEXT NOT NULL,
        attempt_index BIGINT NOT NULL DEFAULT 0 CHECK(attempt_index >= 0),
        transport_attempt_index BIGINT NOT NULL DEFAULT 0 CHECK(transport_attempt_index >= 0),
        transport_status TEXT NOT NULL DEFAULT 'intent'
          CHECK(transport_status IN ('intent', 'accepted', 'dispatch_unknown')),
        dispatch_owner_id TEXT NOT NULL,
        dispatch_lease_expires_at TEXT NOT NULL,
        dispatch_uncertain_at TEXT,
        dispatch_uncertainty_reason TEXT,
        dispatch_reconciled_at TEXT,
        dispatch_reconciled_by TEXT,
        dispatch_reconciliation TEXT
          CHECK(dispatch_reconciliation IS NULL OR dispatch_reconciliation IN (
            'confirmed_not_dispatched',
            'confirmed_dispatched_usage_unknown',
            'superseded_by_new_generation'
          )),
        dispatch_reconciliation_evidence TEXT,
        fallback_index BIGINT NOT NULL DEFAULT 0 CHECK(fallback_index >= 0),
        repair_index BIGINT NOT NULL DEFAULT 0 CHECK(repair_index >= 0),
        workspace_id TEXT,
        session_id TEXT,
        turn_id TEXT,
        durable_run_id TEXT,
        task_id TEXT,
        agent_id TEXT,
        assembly_run_id TEXT,
        assembly_round_index BIGINT CHECK(assembly_round_index IS NULL OR assembly_round_index >= 0),
        assembly_stage TEXT,
        worker_id TEXT,
        utility_kind TEXT,
        credential_type TEXT NOT NULL DEFAULT 'unknown'
          CHECK(credential_type IN ('api_key', 'oauth', 'service_account', 'adc', 'unknown')),
        usage_pool TEXT NOT NULL DEFAULT 'unknown'
          CHECK(usage_pool IN ('standard', 'subscription', 'local', 'unknown')),
        credential_source TEXT NOT NULL DEFAULT 'unknown'
          CHECK(credential_source IN ('inline', 'env', 'keychain', 'oauth', 'adc', 'none', 'unknown')),
        credential_config_fingerprint TEXT,
        pricing_source TEXT NOT NULL DEFAULT 'not_available'
          CHECK(pricing_source IN ('provider_reported', 'gateway_estimate', 'not_available')),
        cost_source TEXT NOT NULL DEFAULT 'not_available'
          CHECK(cost_source IN ('provider_reported', 'gateway_estimate', 'not_available')),
        pricing_catalog_version TEXT,
        pricing_catalog_hash TEXT,
        input_rate_usd_per_million DOUBLE PRECISION CHECK(input_rate_usd_per_million IS NULL OR input_rate_usd_per_million >= 0),
        output_rate_usd_per_million DOUBLE PRECISION CHECK(output_rate_usd_per_million IS NULL OR output_rate_usd_per_million >= 0),
        cached_input_rate_usd_per_million DOUBLE PRECISION CHECK(cached_input_rate_usd_per_million IS NULL OR cached_input_rate_usd_per_million >= 0),
        input_tokens BIGINT CHECK(input_tokens IS NULL OR input_tokens >= 0),
        output_tokens BIGINT CHECK(output_tokens IS NULL OR output_tokens >= 0),
        cached_input_tokens BIGINT CHECK(cached_input_tokens IS NULL OR cached_input_tokens >= 0),
        cost_usd DOUBLE PRECISION CHECK(cost_usd IS NULL OR cost_usd >= 0),
        availability TEXT NOT NULL DEFAULT 'unknown'
          CHECK(availability IN ('tracked', 'unknown')),
        terminal_outcome TEXT NOT NULL DEFAULT 'in_flight'
          CHECK(terminal_outcome IN (
            'in_flight', 'succeeded', 'failed_before_usage', 'failed_after_usage',
            'interrupted_after_dispatch', 'cancelled'
          )),
        error_code TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms BIGINT CHECK(duration_ms IS NULL OR duration_ms >= 0),
        compatibility_projected_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_model_usage_events_workspace_started
        ON model_usage_events(workspace_id, started_at DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS idx_model_usage_events_session_started
        ON model_usage_events(session_id, started_at DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS idx_model_usage_events_turn_started
        ON model_usage_events(turn_id, started_at ASC, event_id ASC);
      CREATE INDEX IF NOT EXISTS idx_model_usage_events_durable_started
        ON model_usage_events(durable_run_id, started_at ASC, event_id ASC);
      CREATE INDEX IF NOT EXISTS idx_model_usage_events_task_started
        ON model_usage_events(task_id, started_at ASC, event_id ASC);
      CREATE INDEX IF NOT EXISTS idx_model_usage_events_assembly_started
        ON model_usage_events(assembly_run_id, assembly_round_index, started_at ASC, event_id ASC);
      CREATE INDEX IF NOT EXISTS idx_model_usage_events_operation_attempt
        ON model_usage_events(operation_id, dispatch_generation, fallback_index, repair_index, attempt_index, transport_attempt_index);
      CREATE INDEX IF NOT EXISTS idx_model_usage_events_outcome_started
        ON model_usage_events(transport_status, terminal_outcome, availability, started_at DESC);

      ALTER TABLE cost_ledger
        ADD COLUMN IF NOT EXISTS canonical_usage_event_id TEXT,
        ADD COLUMN IF NOT EXISTS usage_known_mask TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cost_ledger_canonical_usage_event
        ON cost_ledger(canonical_usage_event_id);
    `,
  },
  {
    version: 101,
    name: "chat_routed_context_snapshots",
    sql: `
      CREATE TABLE IF NOT EXISTS chat_routed_context_snapshots (
        snapshot_id TEXT PRIMARY KEY CHECK(char_length(BTRIM(snapshot_id)) BETWEEN 1 AND 256),
        schema_version TEXT NOT NULL CHECK(schema_version = 'chat.routed-context-snapshot.v1'),
        turn_id TEXT NOT NULL UNIQUE CHECK(char_length(BTRIM(turn_id)) BETWEEN 1 AND 256),
        session_id TEXT NOT NULL CHECK(char_length(BTRIM(session_id)) BETWEEN 1 AND 256),
        workspace_id TEXT NOT NULL CHECK(char_length(BTRIM(workspace_id)) BETWEEN 1 AND 80),
        capability_profile_id TEXT NOT NULL UNIQUE CHECK(char_length(BTRIM(capability_profile_id)) BETWEEN 1 AND 256),
        capability_profile_hash TEXT NOT NULL CHECK(capability_profile_hash ~ '^[a-f0-9]{64}$'),
        source_request_hash TEXT NOT NULL CHECK(source_request_hash ~ '^[a-f0-9]{64}$'),
        content_hash TEXT NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
        snapshot_hash TEXT NOT NULL UNIQUE CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
        effective_provider_id TEXT NOT NULL CHECK(char_length(BTRIM(effective_provider_id)) BETWEEN 1 AND 128),
        effective_model TEXT NOT NULL CHECK(char_length(BTRIM(effective_model)) BETWEEN 1 AND 256),
        context_window_tokens BIGINT NOT NULL CHECK(context_window_tokens > 0),
        prompt_reserved_tokens BIGINT NOT NULL CHECK(prompt_reserved_tokens >= 0),
        output_reserved_tokens BIGINT NOT NULL CHECK(output_reserved_tokens > 0),
        hard_cap_tokens BIGINT NOT NULL CHECK(hard_cap_tokens > 0),
        effective_budget_tokens BIGINT NOT NULL CHECK(
          effective_budget_tokens >= 0 AND effective_budget_tokens <= hard_cap_tokens
        ),
        used_tokens BIGINT NOT NULL CHECK(used_tokens >= 0 AND used_tokens <= effective_budget_tokens),
        source_count BIGINT NOT NULL CHECK(source_count BETWEEN 0 AND 16),
        included_count BIGINT NOT NULL CHECK(included_count >= 0),
        truncated_count BIGINT NOT NULL CHECK(truncated_count >= 0),
        omitted_count BIGINT NOT NULL CHECK(omitted_count >= 0),
        already_attached_count BIGINT NOT NULL CHECK(already_attached_count >= 0),
        estimator_version TEXT NOT NULL CHECK(estimator_version = 'gc-approx-tokens.v1'),
        budget_policy_version TEXT NOT NULL CHECK(budget_policy_version = 'chat.routed-context-budget.v1'),
        snapshot_json TEXT NOT NULL CHECK(octet_length(snapshot_json) <= 1048576),
        created_at TEXT NOT NULL,
        CHECK(prompt_reserved_tokens + output_reserved_tokens <= context_window_tokens),
        CHECK(used_tokens + prompt_reserved_tokens + output_reserved_tokens <= context_window_tokens),
        CHECK(included_count + truncated_count + omitted_count + already_attached_count = source_count)
      );

      CREATE INDEX IF NOT EXISTS idx_chat_routed_context_snapshots_session_created
        ON chat_routed_context_snapshots(session_id, created_at, snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_chat_routed_context_snapshots_workspace_created
        ON chat_routed_context_snapshots(workspace_id, created_at, snapshot_id);

      CREATE OR REPLACE FUNCTION gc_reject_chat_routed_context_snapshot_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'chat routed context snapshots are immutable';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_chat_routed_context_snapshots_no_update ON chat_routed_context_snapshots;
      CREATE TRIGGER trg_chat_routed_context_snapshots_no_update
        BEFORE UPDATE ON chat_routed_context_snapshots
        FOR EACH ROW EXECUTE FUNCTION gc_reject_chat_routed_context_snapshot_mutation();

      DROP TRIGGER IF EXISTS trg_chat_routed_context_snapshots_no_delete ON chat_routed_context_snapshots;
      CREATE TRIGGER trg_chat_routed_context_snapshots_no_delete
        BEFORE DELETE ON chat_routed_context_snapshots
        FOR EACH ROW EXECUTE FUNCTION gc_reject_chat_routed_context_snapshot_mutation();
    `,
  },
  {
    version: 102,
    name: "assembly_model_council_recovery",
    sql: `
      ALTER TABLE assembly_runs
        ADD COLUMN IF NOT EXISTS source_turn_id TEXT,
        ADD COLUMN IF NOT EXISTS run_kind TEXT NOT NULL DEFAULT 'assembly',
        ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS lease_owner_id TEXT,
        ADD COLUMN IF NOT EXISTS lease_expires_at TEXT,
        ADD COLUMN IF NOT EXISTS council_resolution_json TEXT,
        ADD COLUMN IF NOT EXISTS council_evidence_json TEXT;

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'assembly_runs_run_kind_check'
        ) THEN
          ALTER TABLE assembly_runs
            ADD CONSTRAINT assembly_runs_run_kind_check
            CHECK (run_kind IN ('assembly', 'chat_model_council'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'assembly_runs_generation_check'
        ) THEN
          ALTER TABLE assembly_runs
            ADD CONSTRAINT assembly_runs_generation_check CHECK (generation >= 0);
        END IF;
      END $$;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_assembly_runs_council_source_turn
        ON assembly_runs(run_kind, source_turn_id)
        WHERE run_kind = 'chat_model_council' AND source_turn_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_assembly_runs_council_lease
        ON assembly_runs(run_kind, status, lease_expires_at, updated_at DESC);
    `,
  },
  {
    version: 103,
    name: "skill_governance_journey_foundation",
    sql: `
      ALTER TABLE candidate_skill_versions
        ADD COLUMN IF NOT EXISTS workspace_id TEXT,
        ADD COLUMN IF NOT EXISTS source_fingerprint TEXT,
        ADD COLUMN IF NOT EXISTS upstream_snapshot_id TEXT,
        ADD COLUMN IF NOT EXISTS supersedes_version_id TEXT,
        ADD COLUMN IF NOT EXISTS created_by_actor_id TEXT;

      CREATE TABLE IF NOT EXISTS skill_hub_version_claims (
        workspace_id TEXT NOT NULL CHECK(char_length(BTRIM(workspace_id)) BETWEEN 1 AND 256),
        canonical_source_key TEXT NOT NULL CHECK(char_length(BTRIM(canonical_source_key)) BETWEEN 1 AND 1024),
        version_kind TEXT NOT NULL CHECK(version_kind IN ('declared', 'resolved')),
        version_value TEXT NOT NULL CHECK(char_length(BTRIM(version_value)) BETWEEN 1 AND 512),
        first_tree_sha256 TEXT NOT NULL CHECK(first_tree_sha256 ~ '^[a-f0-9]{64}$'),
        first_snapshot_id TEXT NOT NULL CHECK(char_length(BTRIM(first_snapshot_id)) BETWEEN 1 AND 256),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, canonical_source_key, version_kind, version_value)
      );

      CREATE TABLE IF NOT EXISTS skill_hub_audit_floors (
        workspace_id TEXT NOT NULL CHECK(char_length(BTRIM(workspace_id)) BETWEEN 1 AND 256),
        canonical_source_key TEXT NOT NULL CHECK(char_length(BTRIM(canonical_source_key)) BETWEEN 1 AND 1024),
        floor_json TEXT NOT NULL CHECK(
          octet_length(floor_json) <= 16384
          AND floor_json::jsonb ->> 'version' = 'goatcitadel.skill-upstream-audit-floor.v1'
        ),
        floor_sha256 TEXT NOT NULL CHECK(floor_sha256 ~ '^[a-f0-9]{64}$'),
        updated_by_snapshot_id TEXT NOT NULL CHECK(char_length(BTRIM(updated_by_snapshot_id)) BETWEEN 1 AND 256),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, canonical_source_key)
      );

      CREATE TABLE IF NOT EXISTS skill_hub_snapshots (
        snapshot_id TEXT PRIMARY KEY CHECK(char_length(BTRIM(snapshot_id)) BETWEEN 1 AND 256),
        workspace_id TEXT NOT NULL CHECK(char_length(BTRIM(workspace_id)) BETWEEN 1 AND 256),
        operation TEXT NOT NULL CHECK(operation IN ('review', 'install', 'update_check', 'update_stage', 'rollback_check')),
        source_provider TEXT NOT NULL CHECK(char_length(BTRIM(source_provider)) BETWEEN 1 AND 128),
        source_type TEXT NOT NULL CHECK(char_length(BTRIM(source_type)) BETWEEN 1 AND 128),
        source_ref TEXT NOT NULL CHECK(char_length(BTRIM(source_ref)) BETWEEN 1 AND 2048),
        canonical_source_key TEXT NOT NULL CHECK(char_length(BTRIM(canonical_source_key)) BETWEEN 1 AND 1024),
        declared_version TEXT CHECK(declared_version IS NULL OR char_length(BTRIM(declared_version)) BETWEEN 1 AND 512),
        resolved_version TEXT CHECK(resolved_version IS NULL OR char_length(BTRIM(resolved_version)) BETWEEN 1 AND 512),
        content_tree_sha256 TEXT NOT NULL CHECK(content_tree_sha256 ~ '^[a-f0-9]{64}$'),
        provenance_json TEXT NOT NULL CHECK(octet_length(provenance_json) <= 16384),
        audit_json TEXT NOT NULL CHECK(octet_length(audit_json) <= 16384),
        audit_sha256 TEXT NOT NULL CHECK(audit_sha256 ~ '^[a-f0-9]{64}$'),
        audit_floor_json TEXT NOT NULL CHECK(
          octet_length(audit_floor_json) <= 16384
          AND audit_floor_json::jsonb ->> 'version' = 'goatcitadel.skill-upstream-audit-floor.v1'
        ),
        audit_floor_sha256 TEXT NOT NULL CHECK(audit_floor_sha256 ~ '^[a-f0-9]{64}$'),
        permission_envelope_json TEXT NOT NULL CHECK(octet_length(permission_envelope_json) <= 16384),
        permission_envelope_sha256 TEXT NOT NULL CHECK(permission_envelope_sha256 ~ '^[a-f0-9]{64}$'),
        permission_diff_json TEXT NOT NULL CHECK(octet_length(permission_diff_json) <= 16384),
        compatibility_json TEXT NOT NULL CHECK(octet_length(compatibility_json) <= 16384),
        risk_level TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high', 'unknown')),
        trust_disposition TEXT NOT NULL CHECK(trust_disposition IN ('review_only', 'candidate', 'blocked', 'revoked')),
        prior_snapshot_id TEXT CHECK(prior_snapshot_id IS NULL OR char_length(BTRIM(prior_snapshot_id)) BETWEEN 1 AND 256),
        blocker_codes_json TEXT NOT NULL CHECK(octet_length(blocker_codes_json) <= 8192),
        created_at TEXT NOT NULL,
        CHECK(declared_version IS NOT NULL OR resolved_version IS NOT NULL)
      );

      CREATE INDEX IF NOT EXISTS idx_skill_hub_snapshots_source_created
        ON skill_hub_snapshots(workspace_id, canonical_source_key, created_at DESC, snapshot_id DESC);
      CREATE INDEX IF NOT EXISTS idx_skill_hub_snapshots_declared_version
        ON skill_hub_snapshots(workspace_id, canonical_source_key, declared_version)
        WHERE declared_version IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_skill_hub_snapshots_resolved_version
        ON skill_hub_snapshots(workspace_id, canonical_source_key, resolved_version)
        WHERE resolved_version IS NOT NULL;

      CREATE TABLE IF NOT EXISTS skill_learning_evidence (
        evidence_id TEXT PRIMARY KEY CHECK(char_length(BTRIM(evidence_id)) BETWEEN 1 AND 256),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(char_length(BTRIM(idempotency_key)) BETWEEN 1 AND 512),
        workspace_id TEXT NOT NULL CHECK(char_length(BTRIM(workspace_id)) BETWEEN 1 AND 256),
        target_key TEXT NOT NULL CHECK(char_length(BTRIM(target_key)) BETWEEN 1 AND 256),
        fingerprint TEXT NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
        source_kind TEXT NOT NULL CHECK(source_kind IN ('chat_turn', 'library_text')),
        source_session_id TEXT,
        source_turn_id TEXT,
        source_message_id TEXT,
        correction_action_id TEXT NOT NULL CHECK(char_length(BTRIM(correction_action_id)) BETWEEN 1 AND 256),
        actor_id TEXT NOT NULL CHECK(char_length(BTRIM(actor_id)) BETWEEN 1 AND 256),
        source_sha256 TEXT NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
        correction_sha256 TEXT NOT NULL CHECK(correction_sha256 ~ '^[a-f0-9]{64}$'),
        source_artifact_json TEXT CHECK(source_artifact_json IS NULL OR octet_length(source_artifact_json) <= 2048),
        correction_artifact_json TEXT CHECK(correction_artifact_json IS NULL OR octet_length(correction_artifact_json) <= 2048),
        provenance_json TEXT NOT NULL CHECK(octet_length(provenance_json) <= 16384),
        poisoning_status TEXT NOT NULL CHECK(poisoning_status IN ('clean', 'blocked', 'quarantined', 'conflicting')),
        blocker_codes_json TEXT NOT NULL CHECK(octet_length(blocker_codes_json) <= 8192),
        created_at TEXT NOT NULL,
        CHECK(
          (source_kind = 'chat_turn' AND source_session_id IS NOT NULL AND source_turn_id IS NOT NULL AND source_message_id IS NOT NULL)
          OR (source_kind = 'library_text' AND source_session_id IS NULL AND source_turn_id IS NULL AND source_message_id IS NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_skill_learning_evidence_recurrence
        ON skill_learning_evidence(workspace_id, target_key, fingerprint, poisoning_status, source_session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_skill_learning_evidence_target_created
        ON skill_learning_evidence(workspace_id, target_key, created_at DESC, evidence_id DESC);

      CREATE TABLE IF NOT EXISTS candidate_skill_evidence_links (
        version_id TEXT NOT NULL REFERENCES candidate_skill_versions(version_id) ON DELETE RESTRICT,
        evidence_id TEXT NOT NULL REFERENCES skill_learning_evidence(evidence_id) ON DELETE RESTRICT,
        linked_at TEXT NOT NULL,
        PRIMARY KEY (version_id, evidence_id)
      );

      CREATE TABLE IF NOT EXISTS governance_journey_events (
        schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.journey-event.v1'),
        event_id TEXT PRIMARY KEY CHECK(char_length(BTRIM(event_id)) BETWEEN 1 AND 256),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(char_length(BTRIM(idempotency_key)) BETWEEN 1 AND 512),
        scope_kind TEXT NOT NULL CHECK(scope_kind IN ('workspace', 'global')),
        workspace_id TEXT,
        event_type TEXT NOT NULL CHECK(char_length(BTRIM(event_type)) BETWEEN 1 AND 128),
        subject_kind TEXT NOT NULL CHECK(char_length(BTRIM(subject_kind)) BETWEEN 1 AND 128),
        subject_id TEXT NOT NULL CHECK(char_length(BTRIM(subject_id)) BETWEEN 1 AND 256),
        action TEXT NOT NULL CHECK(char_length(BTRIM(action)) BETWEEN 1 AND 128),
        actor_id TEXT NOT NULL CHECK(char_length(BTRIM(actor_id)) BETWEEN 1 AND 256),
        actor_type TEXT NOT NULL CHECK(actor_type IN ('operator', 'system', 'approval_effect')),
        session_id TEXT,
        turn_id TEXT,
        approval_id TEXT,
        fingerprint TEXT CHECK(fingerprint IS NULL OR fingerprint ~ '^[a-f0-9]{64}$'),
        source_kind TEXT,
        source_id TEXT,
        trust_disposition TEXT,
        poisoning_status TEXT CHECK(poisoning_status IS NULL OR poisoning_status IN ('clean', 'blocked', 'quarantined', 'conflicting')),
        evidence_refs_json TEXT NOT NULL CHECK(octet_length(evidence_refs_json) <= 16384),
        provenance_json TEXT NOT NULL CHECK(octet_length(provenance_json) <= 16384),
        summary_json TEXT NOT NULL CHECK(octet_length(summary_json) <= 16384),
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        CHECK(
          (scope_kind = 'workspace' AND workspace_id IS NOT NULL AND char_length(BTRIM(workspace_id)) BETWEEN 1 AND 256)
          OR (scope_kind = 'global' AND workspace_id IS NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_governance_journey_workspace_recorded
        ON governance_journey_events(workspace_id, recorded_at DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS idx_governance_journey_subject_recorded
        ON governance_journey_events(subject_kind, subject_id, recorded_at DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS idx_governance_journey_fingerprint_session
        ON governance_journey_events(fingerprint, session_id, recorded_at DESC, event_id DESC);

      CREATE OR REPLACE FUNCTION gc_guard_candidate_skill_version_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.lifecycle_state NOT IN ('draft', 'candidate') THEN
            RAISE EXCEPTION 'candidate skill versions must be inserted inactive';
          END IF;
          RETURN NEW;
        END IF;
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'candidate skill versions are immutable';
        END IF;
        IF (to_jsonb(NEW) - ARRAY['lifecycle_state', 'updated_at', 'last_successful_execution_at'])
          IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['lifecycle_state', 'updated_at', 'last_successful_execution_at']) THEN
          RAISE EXCEPTION 'candidate skill version content and provenance are immutable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_candidate_skill_versions_governed_mutation ON candidate_skill_versions;
      CREATE TRIGGER trg_candidate_skill_versions_governed_mutation
        BEFORE INSERT OR UPDATE OR DELETE ON candidate_skill_versions
        FOR EACH ROW EXECUTE FUNCTION gc_guard_candidate_skill_version_mutation();

      CREATE OR REPLACE FUNCTION gc_reject_skill_governance_immutable_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'skill governance evidence is immutable';
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_guard_skill_hub_audit_floor_mutation()
      RETURNS trigger AS $$
      DECLARE
        old_floor JSONB;
        new_floor JSONB;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'skill Hub audit floors cannot be deleted';
        END IF;
        IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
          OR NEW.canonical_source_key IS DISTINCT FROM OLD.canonical_source_key
          OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'skill Hub audit floor identity is immutable';
        END IF;

        old_floor := OLD.floor_json::jsonb;
        new_floor := NEW.floor_json::jsonb;
        IF new_floor ->> 'policyId' IS DISTINCT FROM old_floor ->> 'policyId'
          OR (new_floor ->> 'policyRevision')::BIGINT < (old_floor ->> 'policyRevision')::BIGINT
          OR (
            new_floor ->> 'policyVersion' IS DISTINCT FROM old_floor ->> 'policyVersion'
            AND (new_floor ->> 'policyRevision')::BIGINT <= (old_floor ->> 'policyRevision')::BIGINT
          ) THEN
          RAISE EXCEPTION 'skill Hub audit floors are monotonic';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(old_floor -> 'effectiveBlockerCodes') AS old_blocker(value)
          WHERE NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(new_floor -> 'effectiveBlockerCodes') AS new_blocker(value)
            WHERE new_blocker.value = old_blocker.value
          )
        ) THEN
          RAISE EXCEPTION 'skill Hub audit floor blockers are monotonic';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM jsonb_array_elements(old_floor -> 'scanners') AS old_scanner(value)
          WHERE NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(new_floor -> 'scanners') AS new_scanner(value)
            WHERE new_scanner.value ->> 'scannerId' = old_scanner.value ->> 'scannerId'
              AND (new_scanner.value ->> 'revision')::BIGINT >= (old_scanner.value ->> 'revision')::BIGINT
              AND (
                new_scanner.value ->> 'scannerVersion' = old_scanner.value ->> 'scannerVersion'
                OR (new_scanner.value ->> 'revision')::BIGINT > (old_scanner.value ->> 'revision')::BIGINT
              )
              AND NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(old_scanner.value -> 'coverageIds') AS old_coverage(value)
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements_text(new_scanner.value -> 'coverageIds') AS new_coverage(value)
                  WHERE new_coverage.value = old_coverage.value
                )
              )
          )
        ) THEN
          RAISE EXCEPTION 'skill Hub audit floor scanner coverage is monotonic';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_skill_hub_version_claims_immutable ON skill_hub_version_claims;
      CREATE TRIGGER trg_skill_hub_version_claims_immutable BEFORE UPDATE OR DELETE ON skill_hub_version_claims
        FOR EACH ROW EXECUTE FUNCTION gc_reject_skill_governance_immutable_mutation();
      DROP TRIGGER IF EXISTS trg_skill_hub_audit_floors_monotonic ON skill_hub_audit_floors;
      CREATE TRIGGER trg_skill_hub_audit_floors_monotonic BEFORE UPDATE OR DELETE ON skill_hub_audit_floors
        FOR EACH ROW EXECUTE FUNCTION gc_guard_skill_hub_audit_floor_mutation();
      DROP TRIGGER IF EXISTS trg_skill_hub_snapshots_immutable ON skill_hub_snapshots;
      CREATE TRIGGER trg_skill_hub_snapshots_immutable BEFORE UPDATE OR DELETE ON skill_hub_snapshots
        FOR EACH ROW EXECUTE FUNCTION gc_reject_skill_governance_immutable_mutation();
      DROP TRIGGER IF EXISTS trg_skill_learning_evidence_immutable ON skill_learning_evidence;
      CREATE TRIGGER trg_skill_learning_evidence_immutable BEFORE UPDATE OR DELETE ON skill_learning_evidence
        FOR EACH ROW EXECUTE FUNCTION gc_reject_skill_governance_immutable_mutation();
      DROP TRIGGER IF EXISTS trg_candidate_skill_evidence_links_immutable ON candidate_skill_evidence_links;
      CREATE TRIGGER trg_candidate_skill_evidence_links_immutable BEFORE UPDATE OR DELETE ON candidate_skill_evidence_links
        FOR EACH ROW EXECUTE FUNCTION gc_reject_skill_governance_immutable_mutation();
      DROP TRIGGER IF EXISTS trg_governance_journey_events_immutable ON governance_journey_events;
      CREATE TRIGGER trg_governance_journey_events_immutable BEFORE UPDATE OR DELETE ON governance_journey_events
        FOR EACH ROW EXECUTE FUNCTION gc_reject_skill_governance_immutable_mutation();
    `,
  },
  {
    version: 104,
    name: "workspace_path_bridge_snapshots",
    sql: `
      CREATE TABLE IF NOT EXISTS workspace_path_bridge_snapshots (
        snapshot_id TEXT PRIMARY KEY CHECK(char_length(BTRIM(snapshot_id)) BETWEEN 1 AND 256),
        schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.workspace-path-bridge-snapshot.v1'),
        request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
        workspace_id TEXT NOT NULL CHECK(char_length(BTRIM(workspace_id)) BETWEEN 1 AND 256),
        input_flavor TEXT NOT NULL CHECK(input_flavor IN ('windows_native', 'windows_forward', 'msys', 'wsl')),
        target_flavor TEXT NOT NULL CHECK(target_flavor IN ('windows_native', 'windows_forward', 'msys', 'wsl')),
        git_identity_required BOOLEAN NOT NULL,
        input_path_hash TEXT NOT NULL CHECK(input_path_hash ~ '^[a-f0-9]{64}$'),
        allowed_roots_hash TEXT NOT NULL CHECK(allowed_roots_hash ~ '^[a-f0-9]{64}$'),
        canonical_host_path TEXT CHECK(
          canonical_host_path IS NULL OR char_length(BTRIM(canonical_host_path)) BETWEEN 1 AND 2048
        ),
        canonical_target_path TEXT CHECK(
          canonical_target_path IS NULL OR char_length(BTRIM(canonical_target_path)) BETWEEN 1 AND 2048
        ),
        distro TEXT CHECK(distro IS NULL OR char_length(BTRIM(distro)) BETWEEN 1 AND 64),
        round_trip_json TEXT NOT NULL CHECK(
          octet_length(round_trip_json) <= 8192 AND jsonb_typeof(round_trip_json::jsonb) = 'object'
        ),
        git_identity_json TEXT NOT NULL CHECK(
          octet_length(git_identity_json) <= 16384 AND jsonb_typeof(git_identity_json::jsonb) = 'object'
        ),
        status TEXT NOT NULL CHECK(status IN ('verified', 'blocked', 'unavailable')),
        reason_code TEXT CHECK(reason_code IS NULL OR reason_code IN (
          'invalid_path', 'outside_jail', 'canonicalization_failed', 'symlink_escape',
          'round_trip_mismatch', 'wsl_unavailable', 'wsl_conversion_failed',
          'git_not_repository', 'git_unavailable', 'git_verification_failed', 'git_identity_mismatch'
        )),
        callable BOOLEAN NOT NULL,
        snapshot_json TEXT NOT NULL CHECK(
          octet_length(snapshot_json) <= 65536 AND jsonb_typeof(snapshot_json::jsonb) = 'object'
        ),
        snapshot_sha256 TEXT NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
        created_at TEXT NOT NULL,
        CHECK(
          (status = 'verified' AND reason_code IS NULL AND callable
            AND canonical_host_path IS NOT NULL AND canonical_target_path IS NOT NULL)
          OR (status <> 'verified' AND reason_code IS NOT NULL AND NOT callable)
        ),
        CHECK(
          ((input_flavor = 'wsl' OR target_flavor = 'wsl') AND distro IS NOT NULL)
          OR (input_flavor <> 'wsl' AND target_flavor <> 'wsl' AND distro IS NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_path_bridge_workspace_created
        ON workspace_path_bridge_snapshots(workspace_id, created_at DESC, snapshot_id DESC);
      CREATE INDEX IF NOT EXISTS idx_workspace_path_bridge_workspace_request
        ON workspace_path_bridge_snapshots(workspace_id, request_hash);

      CREATE OR REPLACE FUNCTION gc_reject_workspace_path_bridge_snapshot_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'workspace path bridge snapshots are immutable';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_workspace_path_bridge_snapshots_no_update ON workspace_path_bridge_snapshots;
      CREATE TRIGGER trg_workspace_path_bridge_snapshots_no_update
        BEFORE UPDATE ON workspace_path_bridge_snapshots
        FOR EACH ROW EXECUTE FUNCTION gc_reject_workspace_path_bridge_snapshot_mutation();
      DROP TRIGGER IF EXISTS trg_workspace_path_bridge_snapshots_no_delete ON workspace_path_bridge_snapshots;
      CREATE TRIGGER trg_workspace_path_bridge_snapshots_no_delete
        BEFORE DELETE ON workspace_path_bridge_snapshots
        FOR EACH ROW EXECUTE FUNCTION gc_reject_workspace_path_bridge_snapshot_mutation();
    `,
  },
  {
    version: 105,
    name: "context_pressure_recovery_truth",
    sql: `
      ALTER TABLE model_usage_events
        ADD COLUMN IF NOT EXISTS requested_output_token_cap BIGINT CHECK(requested_output_token_cap IS NULL OR requested_output_token_cap > 0),
        ADD COLUMN IF NOT EXISTS effective_output_token_cap BIGINT CHECK(effective_output_token_cap IS NULL OR effective_output_token_cap > 0),
        ADD COLUMN IF NOT EXISTS output_cap_disposition TEXT CHECK(output_cap_disposition IS NULL OR output_cap_disposition IN ('initial', 'preserved_retry', 'reduced_retry')),
        ADD COLUMN IF NOT EXISTS output_cap_recovery_source_event_id TEXT,
        ADD COLUMN IF NOT EXISTS output_cap_recovery_reason_code TEXT CHECK(output_cap_recovery_reason_code IS NULL OR output_cap_recovery_reason_code = 'safe_lower_cap'),
        ADD COLUMN IF NOT EXISTS output_cap_provider_available_tokens BIGINT CHECK(output_cap_provider_available_tokens IS NULL OR output_cap_provider_available_tokens > 0),
        ADD COLUMN IF NOT EXISTS output_cap_provider_minimum_tokens BIGINT CHECK(output_cap_provider_minimum_tokens IS NULL OR output_cap_provider_minimum_tokens > 0),
        ADD COLUMN IF NOT EXISTS output_cap_request_input_estimate BIGINT CHECK(output_cap_request_input_estimate IS NULL OR output_cap_request_input_estimate > 0),
        ADD COLUMN IF NOT EXISTS output_cap_configured_context_window_tokens BIGINT CHECK(output_cap_configured_context_window_tokens IS NULL OR output_cap_configured_context_window_tokens > 0),
        ADD COLUMN IF NOT EXISTS output_cap_safety_margin_tokens BIGINT CHECK(output_cap_safety_margin_tokens IS NULL OR output_cap_safety_margin_tokens >= 0),
        ADD COLUMN IF NOT EXISTS output_cap_evidence_format TEXT CHECK(output_cap_evidence_format IS NULL OR output_cap_evidence_format IN ('anthropic_equation', 'bounded_range', 'context_breakdown', 'character_prompt', 'vllm_context')),
        ADD COLUMN IF NOT EXISTS transport_retry_parent_event_id TEXT,
        ADD COLUMN IF NOT EXISTS transport_retry_reason TEXT CHECK(transport_retry_reason IS NULL OR transport_retry_reason IN ('output_cap_recovery', 'metadata_compatibility'));

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'model_usage_events_cap_retry_lineage_check'
        ) THEN
          ALTER TABLE model_usage_events
          ADD CONSTRAINT model_usage_events_cap_retry_lineage_check CHECK (
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
          ));
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_model_usage_events_output_cap_source
        ON model_usage_events(output_cap_recovery_source_event_id)
        WHERE output_cap_recovery_source_event_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_model_usage_events_transport_retry_parent
        ON model_usage_events(transport_retry_parent_event_id)
        WHERE transport_retry_parent_event_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS chat_compaction_breakers (
        session_id TEXT NOT NULL,
        dimension_hash TEXT NOT NULL,
        provider_id TEXT,
        model TEXT,
        profile_fingerprint TEXT,
        status TEXT NOT NULL DEFAULT 'closed'
          CHECK(status IN ('closed', 'awaiting_evidence', 'tripped', 'blocked_corrupt')),
        fallback_streak INTEGER NOT NULL DEFAULT 0 CHECK(fallback_streak BETWEEN 0 AND 2),
        ineffective_streak INTEGER NOT NULL DEFAULT 0 CHECK(ineffective_streak BETWEEN 0 AND 2),
        pending_attempt_id TEXT,
        pending_state_key TEXT REFERENCES chat_compaction_states(state_key) ON DELETE RESTRICT,
        quarantined_state_key TEXT,
        pending_branch_head_turn_id TEXT,
        pending_observed_turn_count BIGINT CHECK(pending_observed_turn_count IS NULL OR pending_observed_turn_count >= 0),
        pending_disposition TEXT CHECK(pending_disposition IS NULL OR pending_disposition IN ('structured', 'fallback', 'no_progress')),
        pending_started_at TEXT,
        last_attempt_id TEXT,
        last_evidence_turn_id TEXT,
        last_evidence_input_tokens BIGINT CHECK(last_evidence_input_tokens IS NULL OR last_evidence_input_tokens >= 0),
        last_outcome TEXT NOT NULL DEFAULT 'unverified'
          CHECK(last_outcome IN ('healthy', 'ineffective', 'fallback', 'no_progress', 'unverified')),
        revision BIGINT NOT NULL DEFAULT 0 CHECK(revision >= 0),
        last_repaired_at TEXT,
        last_repair_reason TEXT,
        last_repaired_actor_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id, dimension_hash),
        CHECK (
          (
            pending_attempt_id IS NULL AND pending_state_key IS NULL
            AND pending_branch_head_turn_id IS NULL AND pending_observed_turn_count IS NULL
            AND pending_disposition IS NULL AND pending_started_at IS NULL
            AND status <> 'awaiting_evidence'
          ) OR (
            pending_attempt_id IS NOT NULL AND pending_state_key IS NOT NULL
            AND pending_branch_head_turn_id IS NOT NULL AND pending_observed_turn_count IS NOT NULL
            AND pending_disposition IS NOT NULL AND pending_started_at IS NOT NULL
            AND status = 'awaiting_evidence'
          )
        )
      );

      ALTER TABLE chat_compaction_breakers
        ADD COLUMN IF NOT EXISTS quarantined_state_key TEXT;

      CREATE INDEX IF NOT EXISTS idx_chat_compaction_breakers_pending_state
        ON chat_compaction_breakers(pending_state_key)
        WHERE pending_state_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_chat_compaction_breakers_session_status
        ON chat_compaction_breakers(session_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS chat_compaction_breaker_actions (
        action_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        dimension_hash TEXT NOT NULL,
        action_kind TEXT NOT NULL CHECK(action_kind IN ('force', 'repair')),
        expected_breaker_revision BIGINT NOT NULL CHECK(expected_breaker_revision >= 0),
        actor_hash TEXT NOT NULL,
        request_evidence_hash TEXT NOT NULL,
        policy_decision_hash TEXT NOT NULL,
        audit_evidence_hash TEXT NOT NULL,
        approval_id TEXT,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'consumed', 'expired', 'rejected')),
        rejection_reason TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        resulting_attempt_id TEXT,
        resulting_breaker_revision BIGINT CHECK(resulting_breaker_revision IS NULL OR resulting_breaker_revision >= 0),
        quarantined_state_key TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id, dimension_hash)
          REFERENCES chat_compaction_breakers(session_id, dimension_hash) ON DELETE CASCADE,
        CHECK (
          (
            status = 'pending'
            AND rejection_reason IS NULL AND consumed_at IS NULL
            AND resulting_attempt_id IS NULL AND resulting_breaker_revision IS NULL
            AND quarantined_state_key IS NULL
          ) OR (
            status = 'consumed'
            AND rejection_reason IS NULL AND consumed_at IS NOT NULL
            AND resulting_breaker_revision IS NOT NULL
            AND (
              (action_kind = 'force' AND resulting_attempt_id IS NOT NULL AND quarantined_state_key IS NULL)
              OR (action_kind = 'repair' AND resulting_attempt_id IS NULL)
            )
          ) OR (
            status = 'expired'
            AND rejection_reason IS NULL AND consumed_at IS NULL
            AND resulting_attempt_id IS NULL AND resulting_breaker_revision IS NULL
            AND quarantined_state_key IS NULL
          ) OR (
            status = 'rejected'
            AND rejection_reason IS NOT NULL AND consumed_at IS NULL
            AND resulting_attempt_id IS NULL AND resulting_breaker_revision IS NULL
            AND quarantined_state_key IS NULL
          )
        )
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_compaction_breaker_actions_pending
        ON chat_compaction_breaker_actions(session_id, dimension_hash, action_kind)
        WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_chat_compaction_breaker_actions_session_created
        ON chat_compaction_breaker_actions(session_id, created_at DESC, action_id DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_compaction_breaker_actions_status_expiry
        ON chat_compaction_breaker_actions(status, expires_at);

      CREATE OR REPLACE FUNCTION enforce_chat_compaction_breaker_action_identity()
      RETURNS trigger AS $$
      BEGIN
        IF ROW(
          OLD.action_id, OLD.session_id, OLD.dimension_hash, OLD.action_kind,
          OLD.expected_breaker_revision, OLD.actor_hash, OLD.request_evidence_hash,
          OLD.policy_decision_hash, OLD.audit_evidence_hash, OLD.approval_id,
          OLD.reason, OLD.created_at, OLD.expires_at
        ) IS DISTINCT FROM ROW(
          NEW.action_id, NEW.session_id, NEW.dimension_hash, NEW.action_kind,
          NEW.expected_breaker_revision, NEW.actor_hash, NEW.request_evidence_hash,
          NEW.policy_decision_hash, NEW.audit_evidence_hash, NEW.approval_id,
          NEW.reason, NEW.created_at, NEW.expires_at
        ) THEN
          RAISE EXCEPTION 'chat compaction breaker action identity is immutable'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_chat_compaction_breaker_actions_immutable
        ON chat_compaction_breaker_actions;
      CREATE TRIGGER trg_chat_compaction_breaker_actions_immutable
      BEFORE UPDATE ON chat_compaction_breaker_actions
      FOR EACH ROW EXECUTE FUNCTION enforce_chat_compaction_breaker_action_identity();

      CREATE OR REPLACE FUNCTION enforce_chat_compaction_breaker_action_transition()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.status IS DISTINCT FROM 'pending'
          OR (
            NEW.status IS DISTINCT FROM 'consumed'
            AND NEW.status IS DISTINCT FROM 'expired'
            AND NEW.status IS DISTINCT FROM 'rejected'
          ) THEN
          RAISE EXCEPTION 'chat compaction breaker action lifecycle is immutable'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_chat_compaction_breaker_actions_transition
        ON chat_compaction_breaker_actions;
      CREATE TRIGGER trg_chat_compaction_breaker_actions_transition
      BEFORE UPDATE ON chat_compaction_breaker_actions
      FOR EACH ROW EXECUTE FUNCTION enforce_chat_compaction_breaker_action_transition();
    `,
  },
  {
    version: 106,
    name: "skill_aggregate_revision_cas",
    sql: `
      CREATE TABLE IF NOT EXISTS skill_aggregate_revisions (
        aggregate_kind TEXT NOT NULL CHECK(
          aggregate_kind IN ('runtime_skill', 'candidate_skill', 'activation_policy')
        ),
        aggregate_id TEXT NOT NULL CHECK(
          aggregate_id = BTRIM(aggregate_id) AND char_length(aggregate_id) BETWEEN 1 AND 256
        ),
        revision BIGINT NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_at TEXT NOT NULL CHECK(char_length(BTRIM(created_at)) > 0),
        updated_at TEXT NOT NULL CHECK(char_length(BTRIM(updated_at)) > 0),
        PRIMARY KEY (aggregate_kind, aggregate_id)
      );

      INSERT INTO skill_aggregate_revisions (
        aggregate_kind, aggregate_id, revision, created_at, updated_at
      )
      SELECT 'runtime_skill', BTRIM(source.skill_id), 1, MIN(source.created_at), MAX(source.updated_at)
      FROM (
        SELECT skill_id, created_at, updated_at
        FROM skill_lifecycle
        WHERE char_length(BTRIM(created_at)) > 0 AND char_length(BTRIM(updated_at)) > 0
        UNION ALL
        SELECT skill_id, updated_at AS created_at, updated_at
        FROM skill_state
        WHERE char_length(BTRIM(updated_at)) > 0
      ) AS source
      WHERE char_length(BTRIM(source.skill_id)) BETWEEN 1 AND 256
      GROUP BY BTRIM(source.skill_id)
      ON CONFLICT (aggregate_kind, aggregate_id) DO NOTHING;

      INSERT INTO skill_aggregate_revisions (
        aggregate_kind, aggregate_id, revision, created_at, updated_at
      )
      SELECT 'candidate_skill', BTRIM(candidate_id), 1, MIN(created_at), MAX(updated_at)
      FROM candidate_skill_versions
      WHERE char_length(BTRIM(candidate_id)) BETWEEN 1 AND 256
        AND char_length(BTRIM(created_at)) > 0
        AND char_length(BTRIM(updated_at)) > 0
      GROUP BY BTRIM(candidate_id)
      ON CONFLICT (aggregate_kind, aggregate_id) DO NOTHING;

      INSERT INTO skill_aggregate_revisions (
        aggregate_kind, aggregate_id, revision, created_at, updated_at
      )
      SELECT 'activation_policy', 'global', 1, updated_at, updated_at
      FROM system_settings
      WHERE setting_key = 'skill_activation_policy_v1'
        AND char_length(BTRIM(updated_at)) > 0
      ON CONFLICT (aggregate_kind, aggregate_id) DO NOTHING;
    `,
  },
  {
    version: 107,
    name: "skill_hub_lifecycle_foundation",
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_hub_snapshots_workspace_id_tree
        ON skill_hub_snapshots(workspace_id, snapshot_id, content_tree_sha256);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_evidence_skill_hub_identity
        ON runtime_evidence_envelopes(envelope_id, workspace_id, approval_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_governance_journey_skill_hub_identity
        ON governance_journey_events(event_id, workspace_id, approval_id);

      CREATE TABLE IF NOT EXISTS skill_hub_snapshot_artifacts (
        artifact_id TEXT PRIMARY KEY CHECK(char_length(BTRIM(artifact_id)) BETWEEN 1 AND 256),
        workspace_id TEXT NOT NULL CHECK(char_length(BTRIM(workspace_id)) BETWEEN 1 AND 256),
        snapshot_id TEXT NOT NULL CHECK(char_length(BTRIM(snapshot_id)) BETWEEN 1 AND 256),
        content_tree_sha256 TEXT NOT NULL CHECK(content_tree_sha256 ~ '^[0-9a-f]{64}$'),
        bundle_rel_path TEXT NOT NULL CHECK(char_length(BTRIM(bundle_rel_path)) BETWEEN 1 AND 1024),
        manifest_version TEXT NOT NULL CHECK(manifest_version = 'goatcitadel.skill-tree.v1'),
        manifest_json TEXT NOT NULL CHECK(
          jsonb_typeof(manifest_json::jsonb) = 'object' AND octet_length(manifest_json) <= 262144
        ),
        manifest_sha256 TEXT NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
        file_count BIGINT NOT NULL CHECK(file_count BETWEEN 0 AND 96),
        total_bytes BIGINT NOT NULL CHECK(total_bytes BETWEEN 0 AND 4194304),
        created_at TEXT NOT NULL CHECK(char_length(BTRIM(created_at)) > 0),
        UNIQUE(workspace_id, snapshot_id),
        UNIQUE(workspace_id, snapshot_id, content_tree_sha256),
        FOREIGN KEY(workspace_id, snapshot_id, content_tree_sha256)
          REFERENCES skill_hub_snapshots(workspace_id, snapshot_id, content_tree_sha256) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_skill_hub_snapshot_artifacts_tree
        ON skill_hub_snapshot_artifacts(workspace_id, content_tree_sha256, created_at DESC, artifact_id DESC);

      CREATE TABLE IF NOT EXISTS skill_hub_operation_intents (
        operation_id TEXT PRIMARY KEY CHECK(char_length(BTRIM(operation_id)) BETWEEN 1 AND 256),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(char_length(BTRIM(idempotency_key)) BETWEEN 1 AND 512),
        workspace_id TEXT NOT NULL CHECK(char_length(BTRIM(workspace_id)) BETWEEN 1 AND 256),
        operation_kind TEXT NOT NULL CHECK(operation_kind IN (
          'install_inactive', 'stage_update_candidate', 'stage_rollback_candidate', 'activate', 'revoke'
        )),
        approval_id TEXT NOT NULL UNIQUE CHECK(char_length(BTRIM(approval_id)) BETWEEN 1 AND 256),
        snapshot_id TEXT NOT NULL CHECK(char_length(BTRIM(snapshot_id)) BETWEEN 1 AND 256),
        content_tree_sha256 TEXT NOT NULL CHECK(content_tree_sha256 ~ '^[0-9a-f]{64}$'),
        skill_id TEXT NOT NULL CHECK(char_length(BTRIM(skill_id)) BETWEEN 1 AND 256),
        target_candidate_id TEXT CHECK(
          target_candidate_id IS NULL OR char_length(BTRIM(target_candidate_id)) BETWEEN 1 AND 256
        ),
        target_version_id TEXT CHECK(
          target_version_id IS NULL OR char_length(BTRIM(target_version_id)) BETWEEN 1 AND 256
        ),
        supersedes_version_id TEXT CHECK(
          supersedes_version_id IS NULL OR char_length(BTRIM(supersedes_version_id)) BETWEEN 1 AND 256
        ),
        expected_candidate_revision BIGINT CHECK(expected_candidate_revision IS NULL OR expected_candidate_revision > 0),
        expected_runtime_revision BIGINT CHECK(expected_runtime_revision IS NULL OR expected_runtime_revision > 0),
        expected_candidate_absent BIGINT NOT NULL CHECK(expected_candidate_absent IN (0, 1)),
        expected_runtime_absent BIGINT NOT NULL CHECK(expected_runtime_absent IN (0, 1)),
        actor_id TEXT NOT NULL CHECK(char_length(BTRIM(actor_id)) BETWEEN 1 AND 256),
        session_id TEXT CHECK(session_id IS NULL OR char_length(BTRIM(session_id)) BETWEEN 1 AND 256),
        turn_id TEXT CHECK(turn_id IS NULL OR char_length(BTRIM(turn_id)) BETWEEN 1 AND 256),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        created_at TEXT NOT NULL CHECK(char_length(BTRIM(created_at)) > 0),
        FOREIGN KEY(approval_id) REFERENCES approvals(approval_id) ON DELETE RESTRICT,
        FOREIGN KEY(workspace_id, snapshot_id, content_tree_sha256)
          REFERENCES skill_hub_snapshot_artifacts(workspace_id, snapshot_id, content_tree_sha256) ON DELETE RESTRICT,
        CHECK(turn_id IS NULL OR session_id IS NOT NULL),
        CHECK(
          (expected_candidate_absent = 1 AND expected_candidate_revision IS NULL)
          OR (expected_candidate_absent = 0 AND expected_candidate_revision IS NOT NULL)
        ),
        CHECK(
          (expected_runtime_absent = 1 AND expected_runtime_revision IS NULL)
          OR (expected_runtime_absent = 0 AND expected_runtime_revision IS NOT NULL)
        ),
        CHECK(target_candidate_id IS NOT NULL AND target_version_id IS NOT NULL),
        CHECK(
          (operation_kind = 'install_inactive'
            AND expected_candidate_absent = 1
            AND expected_runtime_absent = 1
            AND supersedes_version_id IS NULL)
          OR (operation_kind IN ('stage_update_candidate', 'stage_rollback_candidate')
            AND expected_candidate_absent = 0
            AND expected_runtime_absent = 0
            AND supersedes_version_id IS NOT NULL)
          OR (operation_kind = 'activate' AND expected_candidate_absent = 0)
          OR (operation_kind = 'revoke'
            AND expected_candidate_absent = 0
            AND expected_runtime_absent = 0)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_skill_hub_operation_intents_workspace_skill_created
        ON skill_hub_operation_intents(workspace_id, skill_id, created_at DESC, operation_id DESC);
      CREATE INDEX IF NOT EXISTS idx_skill_hub_operation_intents_snapshot
        ON skill_hub_operation_intents(workspace_id, snapshot_id, created_at DESC, operation_id DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_hub_operation_intents_terminal_identity
        ON skill_hub_operation_intents(operation_id, workspace_id, approval_id, content_tree_sha256);

      CREATE TABLE IF NOT EXISTS skill_hub_operation_settlements (
        settlement_id TEXT PRIMARY KEY CHECK(char_length(BTRIM(settlement_id)) BETWEEN 1 AND 256),
        operation_id TEXT NOT NULL UNIQUE CHECK(char_length(BTRIM(operation_id)) BETWEEN 1 AND 256),
        workspace_id TEXT NOT NULL CHECK(char_length(BTRIM(workspace_id)) BETWEEN 1 AND 256),
        approval_id TEXT NOT NULL CHECK(char_length(BTRIM(approval_id)) BETWEEN 1 AND 256),
        content_tree_sha256 TEXT NOT NULL CHECK(content_tree_sha256 ~ '^[0-9a-f]{64}$'),
        disposition TEXT NOT NULL CHECK(disposition IN ('applied', 'blocked', 'manual_reconciliation')),
        observed_tree_sha256 TEXT NOT NULL CHECK(observed_tree_sha256 ~ '^[0-9a-f]{64}$'),
        candidate_version_id TEXT REFERENCES candidate_skill_versions(version_id) ON DELETE RESTRICT,
        runtime_skill_id TEXT CHECK(
          runtime_skill_id IS NULL OR char_length(BTRIM(runtime_skill_id)) BETWEEN 1 AND 256
        ),
        candidate_revision BIGINT CHECK(candidate_revision IS NULL OR candidate_revision > 0),
        runtime_revision BIGINT CHECK(runtime_revision IS NULL OR runtime_revision > 0),
        evidence_envelope_id TEXT NOT NULL,
        journey_event_id TEXT NOT NULL,
        result_json TEXT NOT NULL CHECK(
          jsonb_typeof(result_json::jsonb) = 'object' AND octet_length(result_json) <= 16384
        ),
        result_sha256 TEXT NOT NULL CHECK(result_sha256 ~ '^[0-9a-f]{64}$'),
        settled_at TEXT NOT NULL CHECK(char_length(BTRIM(settled_at)) > 0),
        FOREIGN KEY(operation_id, workspace_id, approval_id, content_tree_sha256)
          REFERENCES skill_hub_operation_intents(
            operation_id, workspace_id, approval_id, content_tree_sha256
          ) ON DELETE RESTRICT,
        FOREIGN KEY(evidence_envelope_id, workspace_id, approval_id)
          REFERENCES runtime_evidence_envelopes(envelope_id, workspace_id, approval_id) ON DELETE RESTRICT,
        FOREIGN KEY(journey_event_id, workspace_id, approval_id)
          REFERENCES governance_journey_events(event_id, workspace_id, approval_id) ON DELETE RESTRICT,
        CHECK(disposition <> 'applied' OR observed_tree_sha256 = content_tree_sha256)
      );

      CREATE INDEX IF NOT EXISTS idx_skill_hub_operation_settlements_evidence
        ON skill_hub_operation_settlements(evidence_envelope_id, settled_at DESC, settlement_id DESC);
      CREATE INDEX IF NOT EXISTS idx_skill_hub_operation_settlements_journey
        ON skill_hub_operation_settlements(journey_event_id, settled_at DESC, settlement_id DESC);

      CREATE OR REPLACE FUNCTION gc_validate_skill_hub_intent_approval()
      RETURNS trigger AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM approvals AS approval
          WHERE approval.approval_id = NEW.approval_id
            AND approval.status = 'approved'
            AND approval.kind = 'skill_hub.lifecycle'
            AND jsonb_typeof(approval.payload_json::jsonb) = 'object'
            AND approval.payload_json::jsonb ->> 'operationId' = NEW.operation_id
            AND approval.payload_json::jsonb ->> 'requestSha256' = NEW.request_sha256
            AND approval.payload_json::jsonb ->> 'workspaceId' = NEW.workspace_id
            AND approval.payload_json::jsonb ->> 'operationKind' = NEW.operation_kind
            AND approval.payload_json::jsonb ->> 'skillId' = NEW.skill_id
            AND approval.payload_json::jsonb ->> 'snapshotId' = NEW.snapshot_id
            AND approval.payload_json::jsonb ->> 'contentTreeSha256' = NEW.content_tree_sha256
            AND approval.payload_json::jsonb = jsonb_build_object(
              'operationId', NEW.operation_id,
              'requestSha256', NEW.request_sha256,
              'workspaceId', NEW.workspace_id,
              'operationKind', NEW.operation_kind,
              'skillId', NEW.skill_id,
              'snapshotId', NEW.snapshot_id,
              'contentTreeSha256', NEW.content_tree_sha256
            )
            AND approval.linkage_json IS NOT NULL
            AND jsonb_typeof(approval.linkage_json::jsonb) = 'object'
            AND approval.linkage_json::jsonb ->> 'workspaceId' = NEW.workspace_id
            AND (NEW.session_id IS NULL OR approval.linkage_json::jsonb ->> 'sessionId' = NEW.session_id)
            AND (NEW.turn_id IS NULL OR approval.linkage_json::jsonb ->> 'turnId' = NEW.turn_id)
            AND approval.linkage_json::jsonb = jsonb_strip_nulls(jsonb_build_object(
              'workspaceId', NEW.workspace_id,
              'sessionId', NEW.session_id,
              'turnId', NEW.turn_id
            ))
        ) THEN
          RAISE EXCEPTION 'skill Hub operation approval does not match the immutable intent'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_skill_hub_operation_intents_approval_binding
        ON skill_hub_operation_intents;
      CREATE TRIGGER trg_skill_hub_operation_intents_approval_binding
        BEFORE INSERT ON skill_hub_operation_intents
        FOR EACH ROW EXECUTE FUNCTION gc_validate_skill_hub_intent_approval();

      CREATE OR REPLACE FUNCTION gc_validate_skill_hub_settlement_binding()
      RETURNS trigger AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM skill_hub_operation_intents AS intent
          JOIN skill_hub_snapshot_artifacts AS artifact
            ON artifact.workspace_id = intent.workspace_id
            AND artifact.snapshot_id = intent.snapshot_id
            AND artifact.content_tree_sha256 = intent.content_tree_sha256
          JOIN runtime_evidence_envelopes AS evidence
            ON evidence.envelope_id = NEW.evidence_envelope_id
            AND evidence.workspace_id = intent.workspace_id
            AND evidence.approval_id = intent.approval_id
          JOIN governance_journey_events AS journey
            ON journey.event_id = NEW.journey_event_id
            AND journey.workspace_id = intent.workspace_id
            AND journey.approval_id = intent.approval_id
          WHERE intent.operation_id = NEW.operation_id
            AND intent.workspace_id = NEW.workspace_id
            AND intent.approval_id = NEW.approval_id
            AND intent.content_tree_sha256 = NEW.content_tree_sha256
            AND (NEW.disposition <> 'applied' OR NEW.observed_tree_sha256 = intent.content_tree_sha256)
            AND evidence.event_kind = 'approval_resolution'
            AND evidence.payload_hash = NEW.result_sha256
            AND jsonb_typeof(evidence.metadata_json::jsonb) = 'object'
            AND evidence.metadata_json::jsonb ->> 'operationId' = intent.operation_id
            AND evidence.metadata_json::jsonb ->> 'action' = intent.operation_kind
            AND evidence.metadata_json::jsonb ->> 'subjectKind' = 'skill'
            AND evidence.metadata_json::jsonb ->> 'subjectId' = intent.skill_id
            AND evidence.metadata_json::jsonb ->> 'sourceKind' = 'upstream_snapshot'
            AND evidence.metadata_json::jsonb ->> 'sourceId' = intent.snapshot_id
            AND evidence.metadata_json::jsonb ->> 'contentTreeSha256' = intent.content_tree_sha256
            AND evidence.metadata_json::jsonb ->> 'requestSha256' = intent.request_sha256
            AND evidence.metadata_json::jsonb ->> 'resultSha256' = NEW.result_sha256
            AND journey.scope_kind = 'workspace'
            AND journey.event_type = 'skill_hub_lifecycle'
            AND journey.subject_kind = 'skill'
            AND journey.subject_id = intent.skill_id
            AND journey.action = intent.operation_kind
            AND journey.actor_type = 'approval_effect'
            AND journey.fingerprint = intent.request_sha256
            AND journey.source_kind = 'upstream_snapshot'
            AND journey.source_id = intent.snapshot_id
            AND jsonb_typeof(journey.evidence_refs_json::jsonb) = 'array'
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(journey.evidence_refs_json::jsonb) AS ref
              WHERE ref ->> 'owner' = 'approval' AND ref ->> 'refId' = intent.approval_id
            )
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(journey.evidence_refs_json::jsonb) AS ref
              WHERE ref ->> 'owner' = 'upstream_snapshot' AND ref ->> 'refId' = intent.snapshot_id
            )
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(journey.evidence_refs_json::jsonb) AS ref
              WHERE ref ->> 'owner' = 'artifact' AND ref ->> 'refId' = artifact.artifact_id
            )
            AND journey.provenance_json::jsonb ->> 'approvalRequired' = 'true'
            AND journey.provenance_json::jsonb ->> 'sourceRequired' = 'true'
            AND journey.summary_json::jsonb ->> 'operationId' = intent.operation_id
            AND journey.summary_json::jsonb ->> 'requestSha256' = intent.request_sha256
            AND journey.summary_json::jsonb ->> 'contentTreeSha256' = intent.content_tree_sha256
            AND journey.summary_json::jsonb ->> 'resultSha256' = NEW.result_sha256
        ) THEN
          RAISE EXCEPTION 'skill Hub settlement evidence or Journey binding does not match the operation'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_skill_hub_operation_settlements_semantic_binding
        ON skill_hub_operation_settlements;
      CREATE TRIGGER trg_skill_hub_operation_settlements_semantic_binding
        BEFORE INSERT ON skill_hub_operation_settlements
        FOR EACH ROW EXECUTE FUNCTION gc_validate_skill_hub_settlement_binding();

      CREATE OR REPLACE FUNCTION gc_reject_skill_hub_lifecycle_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'skill Hub lifecycle foundation records are immutable'
          USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_skill_hub_snapshot_artifacts_immutable ON skill_hub_snapshot_artifacts;
      CREATE TRIGGER trg_skill_hub_snapshot_artifacts_immutable
        BEFORE UPDATE OR DELETE ON skill_hub_snapshot_artifacts
        FOR EACH ROW EXECUTE FUNCTION gc_reject_skill_hub_lifecycle_mutation();
      DROP TRIGGER IF EXISTS trg_skill_hub_operation_intents_immutable ON skill_hub_operation_intents;
      CREATE TRIGGER trg_skill_hub_operation_intents_immutable
        BEFORE UPDATE OR DELETE ON skill_hub_operation_intents
        FOR EACH ROW EXECUTE FUNCTION gc_reject_skill_hub_lifecycle_mutation();
      DROP TRIGGER IF EXISTS trg_skill_hub_operation_settlements_immutable ON skill_hub_operation_settlements;
      CREATE TRIGGER trg_skill_hub_operation_settlements_immutable
        BEFORE UPDATE OR DELETE ON skill_hub_operation_settlements
        FOR EACH ROW EXECUTE FUNCTION gc_reject_skill_hub_lifecycle_mutation();
    `,
  },
  {
    version: 108,
    name: "governed_external_sources_foundation",
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_path_bridge_workspace_snapshot_hash
        ON workspace_path_bridge_snapshots(workspace_id, snapshot_id, snapshot_sha256);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_session_meta_workspace_session
        ON chat_session_meta(workspace_id, session_id);

      CREATE TABLE IF NOT EXISTS external_source_configs (
        workspace_id TEXT NOT NULL CHECK(char_length(BTRIM(workspace_id)) BETWEEN 1 AND 256),
        source_id TEXT NOT NULL CHECK(char_length(BTRIM(source_id)) BETWEEN 1 AND 256),
        schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.external-source.v1'),
        kind TEXT NOT NULL CHECK(kind IN ('codex_sessions', 'codex_memory', 'claude_sessions', 'claude_memory')),
        label TEXT NOT NULL CHECK(char_length(BTRIM(label)) BETWEEN 1 AND 256),
        owner_actor_id TEXT NOT NULL CHECK(char_length(BTRIM(owner_actor_id)) BETWEEN 1 AND 256),
        auth_actor_id TEXT NOT NULL CHECK(char_length(BTRIM(auth_actor_id)) BETWEEN 1 AND 256),
        auth_actor_source TEXT NOT NULL CHECK(auth_actor_source IN ('token', 'basic', 'loopback', 'device_grant', 'none')),
        canonical_root_path TEXT NOT NULL CHECK(
          char_length(BTRIM(canonical_root_path)) > 1 AND octet_length(canonical_root_path) <= 2048
        ),
        root_identity_sha256 TEXT NOT NULL CHECK(root_identity_sha256 ~ '^[0-9a-f]{64}$'),
        path_bridge_snapshot_id TEXT NOT NULL CHECK(char_length(BTRIM(path_bridge_snapshot_id)) BETWEEN 1 AND 256),
        path_bridge_snapshot_sha256 TEXT NOT NULL CHECK(path_bridge_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
        allowed_roots_sha256 TEXT NOT NULL CHECK(allowed_roots_sha256 ~ '^[0-9a-f]{64}$'),
        input_flavor TEXT NOT NULL CHECK(input_flavor IN ('windows_native', 'windows_forward', 'msys', 'wsl')),
        target_flavor TEXT NOT NULL CHECK(target_flavor IN ('windows_native', 'windows_forward', 'msys', 'wsl')),
        distro TEXT CHECK(distro IS NULL OR char_length(BTRIM(distro)) BETWEEN 1 AND 64),
        require_git_identity BOOLEAN NOT NULL,
        git_identity_sha256 TEXT CHECK(git_identity_sha256 IS NULL OR git_identity_sha256 ~ '^[0-9a-f]{64}$'),
        root_grant_approval_id TEXT CHECK(
          root_grant_approval_id IS NULL OR char_length(BTRIM(root_grant_approval_id)) BETWEEN 1 AND 256
        ),
        ownership_attestation_sha256 TEXT NOT NULL CHECK(ownership_attestation_sha256 ~ '^[0-9a-f]{64}$'),
        adapter_id TEXT NOT NULL CHECK(adapter_id IN (
          'codex.rollout-jsonl.v1', 'codex.memory-markdown.v1',
          'claude.project-jsonl.v1', 'claude.memory-markdown.v1'
        )),
        adapter_version TEXT NOT NULL CHECK(char_length(BTRIM(adapter_version)) BETWEEN 1 AND 128),
        adapter_policy_json TEXT NOT NULL CHECK(
          jsonb_typeof(adapter_policy_json::jsonb) = 'object' AND octet_length(adapter_policy_json) <= 16384
        ),
        revision BIGINT NOT NULL CHECK(revision > 0),
        config_sha256 TEXT NOT NULL CHECK(config_sha256 ~ '^[0-9a-f]{64}$'),
        status TEXT NOT NULL CHECK(status IN ('active', 'disabled', 'revoked')),
        record_json TEXT NOT NULL CHECK(
          jsonb_typeof(record_json::jsonb) = 'object' AND octet_length(record_json) <= 65536
        ),
        created_at TEXT NOT NULL CHECK(char_length(BTRIM(created_at)) > 0),
        updated_at TEXT NOT NULL CHECK(char_length(BTRIM(updated_at)) > 0),
        PRIMARY KEY(workspace_id, source_id),
        UNIQUE(workspace_id, source_id, revision, config_sha256),
        FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
        FOREIGN KEY(workspace_id, path_bridge_snapshot_id, path_bridge_snapshot_sha256)
          REFERENCES workspace_path_bridge_snapshots(workspace_id, snapshot_id, snapshot_sha256) ON DELETE RESTRICT,
        CHECK(
          (require_git_identity AND git_identity_sha256 IS NOT NULL)
          OR (NOT require_git_identity AND git_identity_sha256 IS NULL)
        ),
        CHECK(
          ((input_flavor = 'wsl' OR target_flavor = 'wsl') AND distro IS NOT NULL)
          OR (input_flavor <> 'wsl' AND target_flavor <> 'wsl' AND distro IS NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_external_source_configs_active_identity
        ON external_source_configs(workspace_id, kind, root_identity_sha256) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_external_source_configs_workspace_status
        ON external_source_configs(workspace_id, status, updated_at DESC, source_id DESC);

      CREATE TABLE IF NOT EXISTS external_source_scans (
        workspace_id TEXT NOT NULL,
        scan_id TEXT NOT NULL CHECK(char_length(BTRIM(scan_id)) BETWEEN 1 AND 256),
        source_id TEXT NOT NULL CHECK(char_length(BTRIM(source_id)) BETWEEN 1 AND 256),
        schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.external-source.v1'),
        config_revision BIGINT NOT NULL CHECK(config_revision > 0),
        config_sha256 TEXT NOT NULL CHECK(config_sha256 ~ '^[0-9a-f]{64}$'),
        root_identity_sha256 TEXT NOT NULL CHECK(root_identity_sha256 ~ '^[0-9a-f]{64}$'),
        path_bridge_snapshot_sha256 TEXT NOT NULL CHECK(path_bridge_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
        adapter_id TEXT NOT NULL CHECK(adapter_id IN (
          'codex.rollout-jsonl.v1', 'codex.memory-markdown.v1',
          'claude.project-jsonl.v1', 'claude.memory-markdown.v1'
        )),
        adapter_version TEXT NOT NULL CHECK(char_length(BTRIM(adapter_version)) BETWEEN 1 AND 128),
        manifest_sha256 TEXT NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
        high_water_mtime_ns TEXT CHECK(
          high_water_mtime_ns IS NULL OR high_water_mtime_ns ~ '^[0-9]{20}$'
        ),
        high_water_item_id TEXT CHECK(
          high_water_item_id IS NULL OR char_length(BTRIM(high_water_item_id)) BETWEEN 1 AND 256
        ),
        examined_entry_count BIGINT NOT NULL CHECK(examined_entry_count BETWEEN 0 AND 10000),
        item_count BIGINT NOT NULL CHECK(item_count BETWEEN 0 AND 5000),
        supported_item_count BIGINT NOT NULL CHECK(supported_item_count BETWEEN 0 AND 5000),
        quarantined_item_count BIGINT NOT NULL CHECK(quarantined_item_count BETWEEN 0 AND 5000),
        blocker_codes_json TEXT NOT NULL CHECK(
          jsonb_typeof(blocker_codes_json::jsonb) = 'array' AND octet_length(blocker_codes_json) <= 8192
        ),
        status TEXT NOT NULL CHECK(status IN ('sealed', 'blocked')),
        record_json TEXT NOT NULL CHECK(
          jsonb_typeof(record_json::jsonb) = 'object' AND octet_length(record_json) <= 65536
        ),
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, scan_id),
        UNIQUE(workspace_id, scan_id, source_id),
        FOREIGN KEY(workspace_id, source_id)
          REFERENCES external_source_configs(workspace_id, source_id) ON DELETE RESTRICT,
        CHECK(
          (item_count = 0 AND high_water_mtime_ns IS NULL AND high_water_item_id IS NULL)
          OR (item_count > 0 AND high_water_mtime_ns IS NOT NULL AND high_water_item_id IS NOT NULL)
        ),
        CHECK(supported_item_count + quarantined_item_count <= item_count)
      );
      CREATE INDEX IF NOT EXISTS idx_external_source_scans_source_completed
        ON external_source_scans(workspace_id, source_id, completed_at DESC, scan_id DESC);

      CREATE TABLE IF NOT EXISTS external_source_catalog_items (
        workspace_id TEXT NOT NULL,
        scan_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        item_id TEXT NOT NULL CHECK(char_length(BTRIM(item_id)) BETWEEN 1 AND 256),
        schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.external-source.v1'),
        adapter_id TEXT NOT NULL CHECK(adapter_id IN (
          'codex.rollout-jsonl.v1', 'codex.memory-markdown.v1',
          'claude.project-jsonl.v1', 'claude.memory-markdown.v1'
        )),
        adapter_version TEXT NOT NULL CHECK(char_length(BTRIM(adapter_version)) BETWEEN 1 AND 128),
        normalized_relative_path TEXT NOT NULL CHECK(
          char_length(BTRIM(normalized_relative_path)) BETWEEN 1 AND 2048
        ),
        alias_paths_json TEXT NOT NULL CHECK(
          jsonb_typeof(alias_paths_json::jsonb) = 'array' AND octet_length(alias_paths_json) <= 16384
        ),
        foreign_id_sha256 TEXT NOT NULL CHECK(foreign_id_sha256 ~ '^[0-9a-f]{64}$'),
        producer_version TEXT CHECK(
          producer_version IS NULL OR char_length(BTRIM(producer_version)) BETWEEN 1 AND 128
        ),
        observed_mtime_ns TEXT NOT NULL CHECK(observed_mtime_ns ~ '^[0-9]{20}$'),
        file_identity_sha256 TEXT NOT NULL CHECK(file_identity_sha256 ~ '^[0-9a-f]{64}$'),
        stat_fingerprint_sha256 TEXT NOT NULL CHECK(stat_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
        raw_sha256 TEXT NOT NULL CHECK(raw_sha256 ~ '^[0-9a-f]{64}$'),
        raw_byte_count BIGINT NOT NULL CHECK(raw_byte_count BETWEEN 0 AND 16777216),
        message_count BIGINT NOT NULL CHECK(message_count BETWEEN 0 AND 10000),
        lineage_node_count BIGINT NOT NULL CHECK(lineage_node_count BETWEEN 0 AND 10000),
        lineage_depth BIGINT NOT NULL CHECK(lineage_depth BETWEEN 0 AND 64),
        lineage_sha256 TEXT NOT NULL CHECK(lineage_sha256 ~ '^[0-9a-f]{64}$'),
        disposition TEXT NOT NULL CHECK(
          disposition IN ('supported', 'unsupported_variant', 'quarantined', 'conflicting', 'blocked')
        ),
        reason_codes_json TEXT NOT NULL CHECK(
          jsonb_typeof(reason_codes_json::jsonb) = 'array' AND octet_length(reason_codes_json) <= 8192
        ),
        catalog_item_sha256 TEXT NOT NULL CHECK(catalog_item_sha256 ~ '^[0-9a-f]{64}$'),
        record_json TEXT NOT NULL CHECK(
          jsonb_typeof(record_json::jsonb) = 'object' AND octet_length(record_json) <= 65536
        ),
        PRIMARY KEY(workspace_id, scan_id, item_id),
        UNIQUE(workspace_id, scan_id, item_id, raw_sha256),
        FOREIGN KEY(workspace_id, scan_id, source_id)
          REFERENCES external_source_scans(workspace_id, scan_id, source_id) ON DELETE RESTRICT,
        CHECK(disposition <> 'supported' OR reason_codes_json = '[]')
      );
      CREATE INDEX IF NOT EXISTS idx_external_source_catalog_page
        ON external_source_catalog_items(workspace_id, scan_id, observed_mtime_ns DESC, item_id DESC);
      CREATE INDEX IF NOT EXISTS idx_external_source_catalog_foreign_identity
        ON external_source_catalog_items(workspace_id, source_id, foreign_id_sha256, raw_sha256);

      CREATE TABLE IF NOT EXISTS external_source_import_plans (
        workspace_id TEXT NOT NULL,
        plan_id TEXT NOT NULL CHECK(char_length(BTRIM(plan_id)) BETWEEN 1 AND 256),
        source_id TEXT NOT NULL,
        scan_id TEXT NOT NULL,
        schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.external-source.v1'),
        config_revision BIGINT NOT NULL CHECK(config_revision > 0),
        config_sha256 TEXT NOT NULL CHECK(config_sha256 ~ '^[0-9a-f]{64}$'),
        manifest_sha256 TEXT NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
        adapter_versions_json TEXT NOT NULL CHECK(
          jsonb_typeof(adapter_versions_json::jsonb) = 'array' AND octet_length(adapter_versions_json) <= 8192
        ),
        selected_item_ids_json TEXT NOT NULL CHECK(
          jsonb_typeof(selected_item_ids_json::jsonb) = 'array'
          AND jsonb_array_length(selected_item_ids_json::jsonb) BETWEEN 1 AND 100
          AND octet_length(selected_item_ids_json) <= 32768
        ),
        selected_item_set_sha256 TEXT NOT NULL CHECK(selected_item_set_sha256 ~ '^[0-9a-f]{64}$'),
        raw_set_sha256 TEXT NOT NULL CHECK(raw_set_sha256 ~ '^[0-9a-f]{64}$'),
        raw_byte_count BIGINT NOT NULL CHECK(raw_byte_count BETWEEN 0 AND 26214400),
        normalized_set_sha256 TEXT NOT NULL CHECK(normalized_set_sha256 ~ '^[0-9a-f]{64}$'),
        normalized_byte_count BIGINT NOT NULL CHECK(normalized_byte_count BETWEEN 0 AND 26214400),
        message_count BIGINT NOT NULL CHECK(message_count BETWEEN 0 AND 50000),
        blocker_codes_json TEXT NOT NULL CHECK(
          jsonb_typeof(blocker_codes_json::jsonb) = 'array' AND octet_length(blocker_codes_json) <= 8192
        ),
        staging_lease_id TEXT NOT NULL CHECK(char_length(BTRIM(staging_lease_id)) BETWEEN 1 AND 256),
        staging_expires_at TEXT NOT NULL,
        plan_sha256 TEXT NOT NULL CHECK(plan_sha256 ~ '^[0-9a-f]{64}$'),
        record_json TEXT NOT NULL CHECK(
          jsonb_typeof(record_json::jsonb) = 'object' AND octet_length(record_json) <= 65536
        ),
        created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, plan_id),
        UNIQUE(workspace_id, plan_id, plan_sha256),
        FOREIGN KEY(workspace_id, scan_id, source_id)
          REFERENCES external_source_scans(workspace_id, scan_id, source_id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_external_source_import_plans_source_created
        ON external_source_import_plans(workspace_id, source_id, created_at DESC, plan_id DESC);

      CREATE TABLE IF NOT EXISTS external_source_import_intents (
        workspace_id TEXT NOT NULL,
        import_id TEXT NOT NULL CHECK(char_length(BTRIM(import_id)) BETWEEN 1 AND 256),
        idempotency_key TEXT NOT NULL CHECK(char_length(BTRIM(idempotency_key)) BETWEEN 1 AND 512),
        source_id TEXT NOT NULL,
        scan_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.external-source.v1'),
        config_revision BIGINT NOT NULL CHECK(config_revision > 0),
        config_sha256 TEXT NOT NULL CHECK(config_sha256 ~ '^[0-9a-f]{64}$'),
        manifest_sha256 TEXT NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
        plan_sha256 TEXT NOT NULL CHECK(plan_sha256 ~ '^[0-9a-f]{64}$'),
        selected_item_set_sha256 TEXT NOT NULL CHECK(selected_item_set_sha256 ~ '^[0-9a-f]{64}$'),
        adapter_versions_json TEXT NOT NULL CHECK(
          jsonb_typeof(adapter_versions_json::jsonb) = 'array' AND octet_length(adapter_versions_json) <= 8192
        ),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        record_json TEXT NOT NULL CHECK(
          jsonb_typeof(record_json::jsonb) = 'object' AND octet_length(record_json) <= 65536
        ),
        admitted_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, import_id),
        UNIQUE(workspace_id, idempotency_key),
        UNIQUE(workspace_id, import_id, source_id),
        UNIQUE(workspace_id, import_id, scan_id),
        UNIQUE(workspace_id, import_id, source_id, scan_id),
        FOREIGN KEY(workspace_id, plan_id, plan_sha256)
          REFERENCES external_source_import_plans(workspace_id, plan_id, plan_sha256) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_external_source_import_intents_source_admitted
        ON external_source_import_intents(workspace_id, source_id, admitted_at DESC, import_id DESC);

      CREATE TABLE IF NOT EXISTS external_source_import_items (
        workspace_id TEXT NOT NULL,
        import_id TEXT NOT NULL,
        scan_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.external-source.v1'),
        ordinal BIGINT NOT NULL CHECK(ordinal BETWEEN 0 AND 99),
        adapter_id TEXT NOT NULL CHECK(adapter_id IN (
          'codex.rollout-jsonl.v1', 'codex.memory-markdown.v1',
          'claude.project-jsonl.v1', 'claude.memory-markdown.v1'
        )),
        adapter_version TEXT NOT NULL CHECK(char_length(BTRIM(adapter_version)) BETWEEN 1 AND 128),
        producer_version TEXT CHECK(
          producer_version IS NULL OR char_length(BTRIM(producer_version)) BETWEEN 1 AND 128
        ),
        raw_sha256 TEXT NOT NULL CHECK(raw_sha256 ~ '^[0-9a-f]{64}$'),
        raw_byte_count BIGINT NOT NULL CHECK(raw_byte_count BETWEEN 0 AND 16777216),
        normalized_artifact_sha256 TEXT NOT NULL CHECK(normalized_artifact_sha256 ~ '^[0-9a-f]{64}$'),
        normalized_byte_count BIGINT NOT NULL CHECK(normalized_byte_count BETWEEN 0 AND 8388608),
        artifact_relative_key TEXT NOT NULL CHECK(
          char_length(BTRIM(artifact_relative_key)) BETWEEN 1 AND 2048
          AND artifact_relative_key LIKE 'external-sources/sha256/%'
        ),
        provenance_sha256 TEXT NOT NULL CHECK(provenance_sha256 ~ '^[0-9a-f]{64}$'),
        record_json TEXT NOT NULL CHECK(
          jsonb_typeof(record_json::jsonb) = 'object' AND octet_length(record_json) <= 65536
        ),
        created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, import_id, item_id),
        UNIQUE(workspace_id, import_id, ordinal),
        UNIQUE(workspace_id, import_id, item_id, normalized_artifact_sha256),
        FOREIGN KEY(workspace_id, import_id)
          REFERENCES external_source_import_intents(workspace_id, import_id) ON DELETE RESTRICT,
        FOREIGN KEY(workspace_id, scan_id, item_id, raw_sha256)
          REFERENCES external_source_catalog_items(workspace_id, scan_id, item_id, raw_sha256) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_external_source_import_items_artifact
        ON external_source_import_items(workspace_id, normalized_artifact_sha256, import_id, ordinal);

      CREATE TABLE IF NOT EXISTS external_source_import_settlements (
        workspace_id TEXT NOT NULL,
        settlement_id TEXT NOT NULL CHECK(char_length(BTRIM(settlement_id)) BETWEEN 1 AND 256),
        import_id TEXT NOT NULL,
        schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.external-source.v1'),
        disposition TEXT NOT NULL CHECK(disposition IN ('applied', 'blocked', 'manual_reconciliation')),
        artifact_set_sha256 TEXT CHECK(
          artifact_set_sha256 IS NULL OR artifact_set_sha256 ~ '^[0-9a-f]{64}$'
        ),
        artifacts_verified_at TEXT,
        blocker_codes_json TEXT NOT NULL CHECK(
          jsonb_typeof(blocker_codes_json::jsonb) = 'array' AND octet_length(blocker_codes_json) <= 8192
        ),
        result_sha256 TEXT NOT NULL CHECK(result_sha256 ~ '^[0-9a-f]{64}$'),
        journey_event_id TEXT CHECK(
          journey_event_id IS NULL OR char_length(BTRIM(journey_event_id)) BETWEEN 1 AND 256
        ),
        record_json TEXT NOT NULL CHECK(
          jsonb_typeof(record_json::jsonb) = 'object' AND octet_length(record_json) <= 65536
        ),
        settled_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, settlement_id),
        UNIQUE(workspace_id, import_id),
        FOREIGN KEY(workspace_id, import_id)
          REFERENCES external_source_import_intents(workspace_id, import_id) ON DELETE RESTRICT,
        CHECK(
          (disposition = 'applied' AND artifact_set_sha256 IS NOT NULL
            AND artifacts_verified_at IS NOT NULL AND blocker_codes_json = '[]')
          OR (disposition <> 'applied' AND artifact_set_sha256 IS NULL
            AND artifacts_verified_at IS NULL AND blocker_codes_json <> '[]')
        )
      );

      CREATE TABLE IF NOT EXISTS chat_external_source_attachments (
        workspace_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL CHECK(char_length(BTRIM(attachment_id)) BETWEEN 1 AND 256),
        session_id TEXT NOT NULL CHECK(char_length(BTRIM(session_id)) BETWEEN 1 AND 256),
        source_id TEXT NOT NULL CHECK(char_length(BTRIM(source_id)) BETWEEN 1 AND 256),
        import_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        normalized_artifact_sha256 TEXT NOT NULL CHECK(normalized_artifact_sha256 ~ '^[0-9a-f]{64}$'),
        schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.external-source.v1'),
        mode TEXT NOT NULL CHECK(mode = 'read_only_external'),
        status TEXT NOT NULL CHECK(status IN ('attached', 'detached')),
        revision BIGINT NOT NULL CHECK(revision > 0),
        attached_by_actor_id TEXT NOT NULL CHECK(char_length(BTRIM(attached_by_actor_id)) BETWEEN 1 AND 256),
        attached_at TEXT NOT NULL,
        detached_by_actor_id TEXT,
        detached_at TEXT,
        record_json TEXT NOT NULL CHECK(
          jsonb_typeof(record_json::jsonb) = 'object' AND octet_length(record_json) <= 65536
        ),
        PRIMARY KEY(workspace_id, attachment_id),
        UNIQUE(workspace_id, session_id, import_id, item_id),
        FOREIGN KEY(workspace_id, session_id)
          REFERENCES chat_session_meta(workspace_id, session_id) ON DELETE RESTRICT,
        FOREIGN KEY(workspace_id, import_id, source_id)
          REFERENCES external_source_import_intents(workspace_id, import_id, source_id) ON DELETE RESTRICT,
        FOREIGN KEY(workspace_id, import_id, item_id, normalized_artifact_sha256)
          REFERENCES external_source_import_items(
            workspace_id, import_id, item_id, normalized_artifact_sha256
          ) ON DELETE RESTRICT,
        CHECK(
          (status = 'attached' AND detached_by_actor_id IS NULL AND detached_at IS NULL)
          OR (status = 'detached' AND detached_by_actor_id IS NOT NULL
            AND char_length(BTRIM(detached_by_actor_id)) BETWEEN 1 AND 256 AND detached_at IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_chat_external_source_attachments_session_status
        ON chat_external_source_attachments(
          workspace_id, session_id, status, attached_at DESC, attachment_id DESC
        );

      CREATE TABLE IF NOT EXISTS external_source_knowledge_links (
        workspace_id TEXT NOT NULL,
        link_id TEXT NOT NULL CHECK(char_length(BTRIM(link_id)) BETWEEN 1 AND 256),
        source_id TEXT NOT NULL,
        import_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        normalized_artifact_sha256 TEXT NOT NULL,
        schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.external-source.v1'),
        approval_id TEXT NOT NULL CHECK(char_length(BTRIM(approval_id)) BETWEEN 1 AND 256),
        knowledge_document_id TEXT NOT NULL CHECK(
          char_length(BTRIM(knowledge_document_id)) BETWEEN 1 AND 256
        ),
        thread_knowledge_attachment_id TEXT CHECK(
          thread_knowledge_attachment_id IS NULL
          OR char_length(BTRIM(thread_knowledge_attachment_id)) BETWEEN 1 AND 256
        ),
        provenance_sha256 TEXT NOT NULL CHECK(provenance_sha256 ~ '^[0-9a-f]{64}$'),
        record_json TEXT NOT NULL CHECK(
          jsonb_typeof(record_json::jsonb) = 'object' AND octet_length(record_json) <= 65536
        ),
        created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, link_id),
        UNIQUE(workspace_id, approval_id, import_id, item_id),
        UNIQUE(workspace_id, import_id, item_id, knowledge_document_id),
        FOREIGN KEY(workspace_id, import_id, source_id)
          REFERENCES external_source_import_intents(workspace_id, import_id, source_id) ON DELETE RESTRICT,
        FOREIGN KEY(workspace_id, import_id, item_id, normalized_artifact_sha256)
          REFERENCES external_source_import_items(
            workspace_id, import_id, item_id, normalized_artifact_sha256
          ) ON DELETE RESTRICT,
        FOREIGN KEY(approval_id) REFERENCES approvals(approval_id) ON DELETE RESTRICT,
        FOREIGN KEY(knowledge_document_id) REFERENCES knowledge_documents(doc_id) ON DELETE RESTRICT,
        FOREIGN KEY(thread_knowledge_attachment_id)
          REFERENCES chat_thread_knowledge_attachments(attachment_id) ON DELETE RESTRICT
      );

      CREATE OR REPLACE FUNCTION gc_external_source_enforce_active_cap()
      RETURNS trigger AS $$
      DECLARE
        active_count BIGINT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id, 407));
        IF TG_OP = 'INSERT' AND EXISTS (
          SELECT 1 FROM external_source_configs
          WHERE workspace_id = NEW.workspace_id AND source_id = NEW.source_id
        ) THEN
          RETURN NEW;
        END IF;
        SELECT COUNT(*) INTO active_count
        FROM external_source_configs
        WHERE workspace_id = NEW.workspace_id AND status = 'active';
        IF active_count >= 16 THEN
          RAISE EXCEPTION 'external source active-root limit exceeded'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_external_source_configs_active_cap_insert
        BEFORE INSERT ON external_source_configs
        FOR EACH ROW WHEN (NEW.status = 'active')
        EXECUTE FUNCTION gc_external_source_enforce_active_cap();
      CREATE TRIGGER trg_external_source_configs_active_cap_update
        BEFORE UPDATE ON external_source_configs
        FOR EACH ROW WHEN (OLD.status <> 'active' AND NEW.status = 'active')
        EXECUTE FUNCTION gc_external_source_enforce_active_cap();

      CREATE OR REPLACE FUNCTION gc_external_source_config_cas()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
          OR NEW.source_id IS DISTINCT FROM OLD.source_id
          OR NEW.kind IS DISTINCT FROM OLD.kind
          OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id
          OR NEW.auth_actor_id IS DISTINCT FROM OLD.auth_actor_id
          OR NEW.auth_actor_source IS DISTINCT FROM OLD.auth_actor_source
          OR NEW.canonical_root_path IS DISTINCT FROM OLD.canonical_root_path
          OR NEW.root_identity_sha256 IS DISTINCT FROM OLD.root_identity_sha256
          OR NEW.path_bridge_snapshot_id IS DISTINCT FROM OLD.path_bridge_snapshot_id
          OR NEW.path_bridge_snapshot_sha256 IS DISTINCT FROM OLD.path_bridge_snapshot_sha256
          OR NEW.allowed_roots_sha256 IS DISTINCT FROM OLD.allowed_roots_sha256
          OR NEW.input_flavor IS DISTINCT FROM OLD.input_flavor
          OR NEW.target_flavor IS DISTINCT FROM OLD.target_flavor
          OR NEW.distro IS DISTINCT FROM OLD.distro
          OR NEW.require_git_identity IS DISTINCT FROM OLD.require_git_identity
          OR NEW.git_identity_sha256 IS DISTINCT FROM OLD.git_identity_sha256
          OR NEW.root_grant_approval_id IS DISTINCT FROM OLD.root_grant_approval_id
          OR NEW.ownership_attestation_sha256 IS DISTINCT FROM OLD.ownership_attestation_sha256
          OR NEW.adapter_id IS DISTINCT FROM OLD.adapter_id
          OR NEW.created_at IS DISTINCT FROM OLD.created_at
          OR NEW.revision IS DISTINCT FROM OLD.revision + 1
          OR OLD.status = 'revoked'
        THEN
          RAISE EXCEPTION 'external source config CAS or immutable identity violated'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_external_source_configs_cas
        BEFORE UPDATE ON external_source_configs
        FOR EACH ROW EXECUTE FUNCTION gc_external_source_config_cas();

      CREATE OR REPLACE FUNCTION gc_reject_external_source_immutable_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'external source records are immutable'
          USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_external_source_configs_no_delete
        BEFORE DELETE ON external_source_configs
        FOR EACH ROW EXECUTE FUNCTION gc_reject_external_source_immutable_mutation();
      CREATE TRIGGER trg_external_source_scans_no_update
        BEFORE UPDATE ON external_source_scans
        FOR EACH ROW EXECUTE FUNCTION gc_reject_external_source_immutable_mutation();
      CREATE TRIGGER trg_external_source_scans_no_delete
        BEFORE DELETE ON external_source_scans
        FOR EACH ROW EXECUTE FUNCTION gc_reject_external_source_immutable_mutation();
      CREATE TRIGGER trg_external_source_catalog_no_update
        BEFORE UPDATE ON external_source_catalog_items
        FOR EACH ROW EXECUTE FUNCTION gc_reject_external_source_immutable_mutation();
      CREATE TRIGGER trg_external_source_catalog_no_delete
        BEFORE DELETE ON external_source_catalog_items
        FOR EACH ROW EXECUTE FUNCTION gc_reject_external_source_immutable_mutation();
      CREATE TRIGGER trg_external_source_plans_no_update
        BEFORE UPDATE ON external_source_import_plans
        FOR EACH ROW EXECUTE FUNCTION gc_reject_external_source_immutable_mutation();
      CREATE TRIGGER trg_external_source_plans_no_delete
        BEFORE DELETE ON external_source_import_plans
        FOR EACH ROW EXECUTE FUNCTION gc_reject_external_source_immutable_mutation();
      CREATE TRIGGER trg_external_source_intents_no_update
        BEFORE UPDATE ON external_source_import_intents
        FOR EACH ROW EXECUTE FUNCTION gc_reject_external_source_immutable_mutation();
      CREATE TRIGGER trg_external_source_intents_no_delete
        BEFORE DELETE ON external_source_import_intents
        FOR EACH ROW EXECUTE FUNCTION gc_reject_external_source_immutable_mutation();
      CREATE TRIGGER trg_external_source_items_no_update
        BEFORE UPDATE ON external_source_import_items
        FOR EACH ROW EXECUTE FUNCTION gc_reject_external_source_immutable_mutation();
      CREATE TRIGGER trg_external_source_items_no_delete
        BEFORE DELETE ON external_source_import_items
        FOR EACH ROW EXECUTE FUNCTION gc_reject_external_source_immutable_mutation();
      CREATE TRIGGER trg_external_source_settlements_no_update
        BEFORE UPDATE ON external_source_import_settlements
        FOR EACH ROW EXECUTE FUNCTION gc_reject_external_source_immutable_mutation();
      CREATE TRIGGER trg_external_source_settlements_no_delete
        BEFORE DELETE ON external_source_import_settlements
        FOR EACH ROW EXECUTE FUNCTION gc_reject_external_source_immutable_mutation();
      CREATE TRIGGER trg_external_source_knowledge_links_no_update
        BEFORE UPDATE ON external_source_knowledge_links
        FOR EACH ROW EXECUTE FUNCTION gc_reject_external_source_immutable_mutation();
      CREATE TRIGGER trg_external_source_knowledge_links_no_delete
        BEFORE DELETE ON external_source_knowledge_links
        FOR EACH ROW EXECUTE FUNCTION gc_reject_external_source_immutable_mutation();

      CREATE OR REPLACE FUNCTION gc_external_source_attachment_cas()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.status <> 'attached'
          OR NEW.status <> 'detached'
          OR NEW.revision IS DISTINCT FROM OLD.revision + 1
          OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
          OR NEW.attachment_id IS DISTINCT FROM OLD.attachment_id
          OR NEW.session_id IS DISTINCT FROM OLD.session_id
          OR NEW.source_id IS DISTINCT FROM OLD.source_id
          OR NEW.import_id IS DISTINCT FROM OLD.import_id
          OR NEW.item_id IS DISTINCT FROM OLD.item_id
          OR NEW.normalized_artifact_sha256 IS DISTINCT FROM OLD.normalized_artifact_sha256
          OR NEW.mode IS DISTINCT FROM OLD.mode
          OR NEW.attached_by_actor_id IS DISTINCT FROM OLD.attached_by_actor_id
          OR NEW.attached_at IS DISTINCT FROM OLD.attached_at
        THEN
          RAISE EXCEPTION 'external source attachment transition is invalid'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_chat_external_source_attachments_cas
        BEFORE UPDATE ON chat_external_source_attachments
        FOR EACH ROW EXECUTE FUNCTION gc_external_source_attachment_cas();
      CREATE TRIGGER trg_chat_external_source_attachments_no_delete
        BEFORE DELETE ON chat_external_source_attachments
        FOR EACH ROW EXECUTE FUNCTION gc_reject_external_source_immutable_mutation();
    `,
  },
  {
    version: 109,
    name: "trusted_ops_saved_boards",
    sql: `
      CREATE TABLE IF NOT EXISTS ops_saved_boards (
        workspace_id TEXT NOT NULL CHECK(
          char_length(BTRIM(workspace_id)) BETWEEN 1 AND 256
          AND workspace_id = BTRIM(workspace_id) AND workspace_id !~ '[[:cntrl:]]'
        ),
        board_id TEXT NOT NULL CHECK(
          char_length(BTRIM(board_id)) BETWEEN 1 AND 256
          AND board_id = BTRIM(board_id) AND board_id !~ '[[:cntrl:]]'
        ),
        schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.ops-board.v1'),
        name TEXT NOT NULL CHECK(
          char_length(name) BETWEEN 1 AND 120 AND name = BTRIM(name) AND name !~ '[[:cntrl:]]'
        ),
        description TEXT CHECK(
          description IS NULL OR (
            char_length(description) BETWEEN 1 AND 500
            AND description = BTRIM(description) AND description !~ '[[:cntrl:]]'
          )
        ),
        layout_json TEXT NOT NULL CHECK(
          jsonb_typeof(layout_json::jsonb) = 'array'
          AND jsonb_array_length(layout_json::jsonb) BETWEEN 1 AND 12
          AND octet_length(layout_json) <= 16384
        ),
        status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
        revision BIGINT NOT NULL CHECK(revision > 0),
        created_by_actor_id TEXT NOT NULL CHECK(
          char_length(BTRIM(created_by_actor_id)) BETWEEN 1 AND 256
          AND created_by_actor_id = BTRIM(created_by_actor_id) AND created_by_actor_id !~ '[[:cntrl:]]'
        ),
        created_at TEXT NOT NULL CHECK(char_length(BTRIM(created_at)) > 0),
        updated_by_actor_id TEXT NOT NULL CHECK(
          char_length(BTRIM(updated_by_actor_id)) BETWEEN 1 AND 256
          AND updated_by_actor_id = BTRIM(updated_by_actor_id) AND updated_by_actor_id !~ '[[:cntrl:]]'
        ),
        updated_at TEXT NOT NULL CHECK(char_length(BTRIM(updated_at)) > 0),
        archived_by_actor_id TEXT CHECK(
          archived_by_actor_id IS NULL OR (
            char_length(BTRIM(archived_by_actor_id)) BETWEEN 1 AND 256
            AND archived_by_actor_id = BTRIM(archived_by_actor_id) AND archived_by_actor_id !~ '[[:cntrl:]]'
          )
        ),
        archived_at TEXT CHECK(archived_at IS NULL OR char_length(BTRIM(archived_at)) > 0),
        idempotency_key TEXT NOT NULL CHECK(
          char_length(BTRIM(idempotency_key)) BETWEEN 1 AND 512
          AND idempotency_key = BTRIM(idempotency_key) AND idempotency_key !~ '[[:cntrl:]]'
        ),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        PRIMARY KEY(workspace_id, board_id),
        UNIQUE(workspace_id, idempotency_key),
        FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
        CHECK(
          (status = 'active' AND archived_by_actor_id IS NULL AND archived_at IS NULL)
          OR (status = 'archived' AND archived_by_actor_id IS NOT NULL AND archived_at IS NOT NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_ops_saved_boards_workspace_status_updated
        ON ops_saved_boards(workspace_id, status, updated_at DESC, board_id DESC);

      CREATE OR REPLACE FUNCTION gc_ops_saved_boards_insert_invariant()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.status IS DISTINCT FROM 'active'
          OR NEW.revision IS DISTINCT FROM 1
          OR NEW.created_by_actor_id IS DISTINCT FROM NEW.updated_by_actor_id
          OR NEW.created_at IS DISTINCT FROM NEW.updated_at
          OR NEW.archived_by_actor_id IS NOT NULL
          OR NEW.archived_at IS NOT NULL
        THEN
          RAISE EXCEPTION 'ops saved board insert invariant violated'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_ops_saved_boards_insert_invariant ON ops_saved_boards;
      CREATE TRIGGER trg_ops_saved_boards_insert_invariant
        BEFORE INSERT ON ops_saved_boards
        FOR EACH ROW EXECUTE FUNCTION gc_ops_saved_boards_insert_invariant();

      CREATE OR REPLACE FUNCTION gc_ops_saved_boards_enforce_cap()
      RETURNS trigger AS $$
      DECLARE
        board_count BIGINT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id, 410));
        IF EXISTS (
          SELECT 1 FROM ops_saved_boards
          WHERE workspace_id = NEW.workspace_id AND idempotency_key = NEW.idempotency_key
        ) THEN
          RETURN NEW;
        END IF;
        SELECT COUNT(*) INTO board_count
        FROM ops_saved_boards
        WHERE workspace_id = NEW.workspace_id;
        IF board_count >= 64 THEN
          RAISE EXCEPTION 'ops saved board workspace limit exceeded'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_ops_saved_boards_cap_insert ON ops_saved_boards;
      CREATE TRIGGER trg_ops_saved_boards_cap_insert
        BEFORE INSERT ON ops_saved_boards
        FOR EACH ROW EXECUTE FUNCTION gc_ops_saved_boards_enforce_cap();

      CREATE OR REPLACE FUNCTION gc_ops_saved_boards_cas_update()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
          OR NEW.board_id IS DISTINCT FROM OLD.board_id
          OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
          OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
          OR NEW.created_at IS DISTINCT FROM OLD.created_at
          OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
          OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
          OR NEW.revision IS DISTINCT FROM OLD.revision + 1
          OR NEW.updated_at < OLD.updated_at
          OR NOT (
            (
              OLD.status = 'active' AND NEW.status = 'active'
              AND NEW.archived_by_actor_id IS NULL AND NEW.archived_at IS NULL
            ) OR (
              OLD.status = 'active' AND NEW.status = 'archived'
              AND NEW.name IS NOT DISTINCT FROM OLD.name
              AND NEW.description IS NOT DISTINCT FROM OLD.description
              AND NEW.layout_json IS NOT DISTINCT FROM OLD.layout_json
              AND NEW.archived_by_actor_id IS NOT DISTINCT FROM NEW.updated_by_actor_id
              AND NEW.archived_at IS NOT DISTINCT FROM NEW.updated_at
            ) OR (
              OLD.status = 'archived' AND NEW.status = 'active'
              AND NEW.name IS NOT DISTINCT FROM OLD.name
              AND NEW.description IS NOT DISTINCT FROM OLD.description
              AND NEW.layout_json IS NOT DISTINCT FROM OLD.layout_json
              AND NEW.archived_by_actor_id IS NULL AND NEW.archived_at IS NULL
            )
          )
        THEN
          RAISE EXCEPTION 'ops saved board CAS or transition invariant violated'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_ops_saved_boards_cas_update ON ops_saved_boards;
      CREATE TRIGGER trg_ops_saved_boards_cas_update
        BEFORE UPDATE ON ops_saved_boards
        FOR EACH ROW EXECUTE FUNCTION gc_ops_saved_boards_cas_update();

      CREATE OR REPLACE FUNCTION gc_ops_saved_boards_reject_delete()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'ops saved boards cannot be deleted'
          USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_ops_saved_boards_no_delete ON ops_saved_boards;
      CREATE TRIGGER trg_ops_saved_boards_no_delete
        BEFORE DELETE ON ops_saved_boards
        FOR EACH ROW EXECUTE FUNCTION gc_ops_saved_boards_reject_delete();
    `,
  },
  {
    version: 110,
    name: "governed_mesh_capability_publication",
    sql: `
      CREATE TABLE IF NOT EXISTS mesh_capability_publishers (
        workspace_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        admission_generation BIGINT NOT NULL CHECK(admission_generation > 0),
        publisher_generation BIGINT NOT NULL CHECK(publisher_generation > 0),
        mtls_required BIGINT NOT NULL CHECK(mtls_required IN (0, 1)),
        tls_fingerprint TEXT,
        publication_lease_key TEXT NOT NULL,
        publication_lease_fencing_token BIGINT NOT NULL CHECK(publication_lease_fencing_token > 0),
        publication_lease_expires_at TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, node_id, publisher_generation),
        UNIQUE(workspace_id, idempotency_key),
        FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
        FOREIGN KEY(node_id) REFERENCES mesh_nodes(node_id) ON DELETE RESTRICT,
        CHECK(mtls_required = 0 OR (tls_fingerprint IS NOT NULL AND char_length(BTRIM(tls_fingerprint)) > 0))
      );

      CREATE TABLE IF NOT EXISTS mesh_capability_publisher_health (
        workspace_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        publisher_generation BIGINT NOT NULL,
        health_generation BIGINT NOT NULL CHECK(health_generation > 0),
        status TEXT NOT NULL CHECK(status IN ('online', 'suspect', 'offline', 'revoked')),
        publication_lease_fencing_token BIGINT NOT NULL CHECK(publication_lease_fencing_token > 0),
        publication_lease_expires_at TEXT NOT NULL,
        tls_fingerprint TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, node_id, publisher_generation),
        FOREIGN KEY(workspace_id, node_id, publisher_generation)
          REFERENCES mesh_capability_publishers(workspace_id, node_id, publisher_generation) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS mesh_capability_manifests (
        workspace_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        admission_generation BIGINT NOT NULL CHECK(admission_generation > 0),
        publisher_generation BIGINT NOT NULL,
        publication_key TEXT NOT NULL,
        publication_lease_fencing_token BIGINT NOT NULL CHECK(publication_lease_fencing_token > 0),
        manifest_sha256 TEXT NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
        supersedes_manifest_sha256 TEXT,
        schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.mesh-capability-manifest.v1'),
        entry_count BIGINT NOT NULL CHECK(entry_count BETWEEN 1 AND 128),
        canonical_json TEXT NOT NULL CHECK(
          jsonb_typeof(canonical_json::jsonb) = 'object' AND octet_length(canonical_json) <= 524288
        ),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, node_id, publisher_generation, manifest_sha256),
        UNIQUE(workspace_id, publication_key),
        FOREIGN KEY(workspace_id, node_id, publisher_generation)
          REFERENCES mesh_capability_publishers(workspace_id, node_id, publisher_generation) ON DELETE RESTRICT,
        FOREIGN KEY(workspace_id, node_id, publisher_generation, supersedes_manifest_sha256)
          REFERENCES mesh_capability_manifests(workspace_id, node_id, publisher_generation, manifest_sha256) ON DELETE RESTRICT,
        CHECK(supersedes_manifest_sha256 IS NULL OR supersedes_manifest_sha256 <> manifest_sha256)
      );

      CREATE TABLE IF NOT EXISTS mesh_capability_manifest_entries (
        workspace_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        publisher_generation BIGINT NOT NULL,
        manifest_sha256 TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        local_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('tool', 'mcp_server', 'skill')),
        descriptor_sha256 TEXT NOT NULL CHECK(descriptor_sha256 ~ '^[0-9a-f]{64}$'),
        permission_envelope_sha256 TEXT NOT NULL CHECK(permission_envelope_sha256 ~ '^[0-9a-f]{64}$'),
        entry_sha256 TEXT NOT NULL CHECK(entry_sha256 ~ '^[0-9a-f]{64}$'),
        effect_posture TEXT NOT NULL CHECK(effect_posture IN ('none', 'read_only', 'write_local', 'external_side_effect', 'unknown')),
        canonical_json TEXT NOT NULL CHECK(
          jsonb_typeof(canonical_json::jsonb) = 'object' AND octet_length(canonical_json) <= 65536
        ),
        PRIMARY KEY(workspace_id, node_id, publisher_generation, manifest_sha256, capability_id),
        UNIQUE(workspace_id, node_id, publisher_generation, manifest_sha256, kind, local_id),
        FOREIGN KEY(workspace_id, node_id, publisher_generation, manifest_sha256)
          REFERENCES mesh_capability_manifests(workspace_id, node_id, publisher_generation, manifest_sha256) ON DELETE RESTRICT,
        CHECK(capability_id = 'mesh:' || node_id || ':' || kind || ':' || local_id)
      );

      CREATE TABLE IF NOT EXISTS mesh_capability_activations (
        workspace_id TEXT NOT NULL,
        activation_id TEXT NOT NULL,
        activation_revision BIGINT NOT NULL CHECK(activation_revision > 0),
        capability_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        publisher_generation BIGINT NOT NULL,
        health_generation BIGINT NOT NULL,
        publication_lease_fencing_token BIGINT NOT NULL,
        manifest_sha256 TEXT NOT NULL,
        entry_sha256 TEXT NOT NULL CHECK(entry_sha256 ~ '^[0-9a-f]{64}$'),
        descriptor_sha256 TEXT NOT NULL,
        permission_envelope_sha256 TEXT NOT NULL,
        effect_posture TEXT NOT NULL,
        permission_diff_json TEXT NOT NULL CHECK(jsonb_typeof(permission_diff_json::jsonb) = 'object'),
        effect_diff_json TEXT NOT NULL CHECK(jsonb_typeof(effect_diff_json::jsonb) = 'object'),
        approval_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        session_id TEXT,
        turn_id TEXT,
        idempotency_key TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, activation_id),
        UNIQUE(workspace_id, idempotency_key),
        FOREIGN KEY(workspace_id, node_id, publisher_generation, manifest_sha256, capability_id)
          REFERENCES mesh_capability_manifest_entries(workspace_id, node_id, publisher_generation, manifest_sha256, capability_id) ON DELETE RESTRICT,
        FOREIGN KEY(approval_id) REFERENCES approvals(approval_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS mesh_capability_activation_revocations (
        workspace_id TEXT NOT NULL,
        activation_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        revoked_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, activation_id),
        UNIQUE(workspace_id, idempotency_key),
        FOREIGN KEY(workspace_id, activation_id)
          REFERENCES mesh_capability_activations(workspace_id, activation_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS mesh_capability_invocation_intents (
        workspace_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        activation_id TEXT NOT NULL,
        activation_revision BIGINT NOT NULL CHECK(activation_revision > 0),
        capability_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        publisher_generation BIGINT NOT NULL,
        health_generation BIGINT NOT NULL,
        publication_lease_fencing_token BIGINT NOT NULL,
        manifest_sha256 TEXT NOT NULL,
        entry_sha256 TEXT NOT NULL CHECK(entry_sha256 ~ '^[0-9a-f]{64}$'),
        descriptor_sha256 TEXT NOT NULL,
        permission_envelope_sha256 TEXT NOT NULL,
        execution_profile_sha256 TEXT NOT NULL CHECK(execution_profile_sha256 ~ '^[0-9a-f]{64}$'),
        input_sha256 TEXT NOT NULL CHECK(input_sha256 ~ '^[0-9a-f]{64}$'),
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        run_id TEXT,
        approval_id TEXT,
        deadline_at TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, invocation_id),
        UNIQUE(workspace_id, idempotency_key),
        FOREIGN KEY(workspace_id, activation_id)
          REFERENCES mesh_capability_activations(workspace_id, activation_id) ON DELETE RESTRICT,
        FOREIGN KEY(approval_id) REFERENCES approvals(approval_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS mesh_capability_invocation_settlements (
        workspace_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK(disposition IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'unknown')),
        output_sha256 TEXT,
        error_code TEXT,
        settlement_sha256 TEXT NOT NULL CHECK(settlement_sha256 ~ '^[0-9a-f]{64}$'),
        effective_cost_attribution_sha256 TEXT,
        publisher_generation BIGINT NOT NULL,
        publication_lease_fencing_token BIGINT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        settled_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, invocation_id),
        UNIQUE(workspace_id, idempotency_key),
        FOREIGN KEY(workspace_id, invocation_id)
          REFERENCES mesh_capability_invocation_intents(workspace_id, invocation_id) ON DELETE RESTRICT,
        CHECK(output_sha256 IS NULL OR output_sha256 ~ '^[0-9a-f]{64}$'),
        CHECK(effective_cost_attribution_sha256 IS NULL OR effective_cost_attribution_sha256 ~ '^[0-9a-f]{64}$')
      );

      CREATE INDEX IF NOT EXISTS idx_mesh_capability_manifests_publisher_created
        ON mesh_capability_manifests(workspace_id, node_id, publisher_generation, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mesh_capability_entries_capability
        ON mesh_capability_manifest_entries(workspace_id, capability_id, manifest_sha256);
      CREATE INDEX IF NOT EXISTS idx_mesh_capability_activations_capability_created
        ON mesh_capability_activations(workspace_id, capability_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mesh_capability_intents_activation_created
        ON mesh_capability_invocation_intents(workspace_id, activation_id, created_at DESC);

      CREATE OR REPLACE FUNCTION gc_mesh_capability_db_now()
      RETURNS TEXT AS $$
        SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
      $$ LANGUAGE SQL VOLATILE;

      CREATE OR REPLACE FUNCTION gc_mesh_capability_publishers_guard()
      RETURNS trigger AS $$
      DECLARE publisher_count BIGINT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id, 408));
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id || ':' || NEW.node_id, 409));
        IF EXISTS (
          SELECT 1 FROM mesh_capability_publishers
          WHERE workspace_id = NEW.workspace_id AND node_id = NEW.node_id
            AND publisher_generation >= NEW.publisher_generation
        ) THEN RAISE EXCEPTION 'mesh capability publisher generation must be monotonic' USING ERRCODE = '23514'; END IF;
        IF EXISTS (
          SELECT 1 FROM mesh_capability_publishers
          WHERE workspace_id = NEW.workspace_id AND node_id = NEW.node_id
            AND admission_generation > NEW.admission_generation
        ) THEN RAISE EXCEPTION 'mesh capability admission generation cannot regress' USING ERRCODE = '23514'; END IF;
        IF NOT EXISTS (
          SELECT 1 FROM mesh_capability_publishers
          WHERE workspace_id = NEW.workspace_id AND node_id = NEW.node_id
        ) THEN
          SELECT COUNT(DISTINCT node_id) INTO publisher_count
          FROM mesh_capability_publishers WHERE workspace_id = NEW.workspace_id;
          IF publisher_count >= 16 THEN RAISE EXCEPTION 'mesh capability publisher workspace limit exceeded' USING ERRCODE = '23514'; END IF;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM mesh_nodes node
          JOIN mesh_leases lease ON lease.lease_key = NEW.publication_lease_key
          WHERE node.node_id = NEW.node_id AND node.status = 'online'
            AND lease.holder_node_id = NEW.node_id
            AND lease.fencing_token = NEW.publication_lease_fencing_token
            AND lease.expires_at > gc_mesh_capability_db_now()
            AND lease.expires_at = NEW.publication_lease_expires_at
            AND (NEW.mtls_required = 0 OR node.tls_fingerprint = NEW.tls_fingerprint)
        ) THEN RAISE EXCEPTION 'mesh capability publisher live database-clock lease invariant violated' USING ERRCODE = '23514'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_mesh_capability_publishers_insert_guard
        BEFORE INSERT ON mesh_capability_publishers
        FOR EACH ROW EXECUTE FUNCTION gc_mesh_capability_publishers_guard();

      CREATE OR REPLACE FUNCTION gc_mesh_capability_health_guard()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.health_generation <> 1 OR NEW.status <> 'online' OR NOT EXISTS (
            SELECT 1 FROM mesh_capability_publishers publisher
            WHERE publisher.workspace_id = NEW.workspace_id AND publisher.node_id = NEW.node_id
              AND publisher.publisher_generation = NEW.publisher_generation
              AND publisher.publication_lease_fencing_token = NEW.publication_lease_fencing_token
              AND publisher.publication_lease_expires_at = NEW.publication_lease_expires_at
              AND publisher.tls_fingerprint IS NOT DISTINCT FROM NEW.tls_fingerprint
          ) THEN RAISE EXCEPTION 'mesh capability publisher health insert invariant violated' USING ERRCODE = '23514'; END IF;
        ELSE
          IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.node_id IS DISTINCT FROM OLD.node_id
            OR NEW.publisher_generation IS DISTINCT FROM OLD.publisher_generation
            OR OLD.status IN ('offline', 'revoked')
            OR NOT (
              (
                NEW.health_generation = OLD.health_generation
                AND NEW.status = 'online' AND OLD.status = 'online'
                AND NEW.publication_lease_fencing_token = OLD.publication_lease_fencing_token
                AND NEW.publication_lease_expires_at > OLD.publication_lease_expires_at
                AND NEW.tls_fingerprint IS NOT DISTINCT FROM OLD.tls_fingerprint
                AND NEW.publication_lease_expires_at > gc_mesh_capability_db_now()
                AND EXISTS (
                  SELECT 1 FROM mesh_capability_publishers publisher
                  JOIN mesh_leases lease ON lease.lease_key = publisher.publication_lease_key
                  WHERE publisher.workspace_id = NEW.workspace_id AND publisher.node_id = NEW.node_id
                    AND publisher.publisher_generation = NEW.publisher_generation
                    AND publisher.publication_lease_fencing_token = NEW.publication_lease_fencing_token
                    AND publisher.tls_fingerprint IS NOT DISTINCT FROM NEW.tls_fingerprint
                    AND lease.holder_node_id = NEW.node_id
                    AND lease.fencing_token = NEW.publication_lease_fencing_token
                    AND lease.expires_at = NEW.publication_lease_expires_at
                    AND lease.expires_at > gc_mesh_capability_db_now()
                )
              ) OR (
                NEW.health_generation = OLD.health_generation + 1
                AND NEW.publication_lease_fencing_token = OLD.publication_lease_fencing_token
                AND NEW.tls_fingerprint IS NOT DISTINCT FROM OLD.tls_fingerprint
                AND (
                  NEW.status <> 'online' OR (
                    NEW.publication_lease_expires_at > gc_mesh_capability_db_now()
                    AND EXISTS (
                      SELECT 1 FROM mesh_capability_publishers publisher
                      JOIN mesh_leases lease ON lease.lease_key = publisher.publication_lease_key
                      WHERE publisher.workspace_id = NEW.workspace_id AND publisher.node_id = NEW.node_id
                        AND publisher.publisher_generation = NEW.publisher_generation
                        AND publisher.publication_lease_fencing_token = NEW.publication_lease_fencing_token
                        AND publisher.tls_fingerprint IS NOT DISTINCT FROM NEW.tls_fingerprint
                        AND lease.holder_node_id = NEW.node_id
                        AND lease.fencing_token = NEW.publication_lease_fencing_token
                        AND lease.expires_at = NEW.publication_lease_expires_at
                        AND lease.expires_at > gc_mesh_capability_db_now()
                    )
                  )
                )
              )
            )
          THEN RAISE EXCEPTION 'mesh capability publisher health CAS invariant violated' USING ERRCODE = '23514'; END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_mesh_capability_health_guard
        BEFORE INSERT OR UPDATE ON mesh_capability_publisher_health
        FOR EACH ROW EXECUTE FUNCTION gc_mesh_capability_health_guard();

      CREATE OR REPLACE FUNCTION gc_mesh_capability_manifest_guard()
      RETURNS trigger AS $$
      DECLARE active_manifest_count BIGINT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id || ':' || NEW.node_id || ':' || NEW.publisher_generation::TEXT, 408));
        IF NOT EXISTS (
          SELECT 1 FROM mesh_capability_publishers publisher
          JOIN mesh_capability_publisher_health health
            ON health.workspace_id = publisher.workspace_id AND health.node_id = publisher.node_id
           AND health.publisher_generation = publisher.publisher_generation
          WHERE publisher.workspace_id = NEW.workspace_id AND publisher.node_id = NEW.node_id
            AND publisher.publisher_generation = NEW.publisher_generation
            AND publisher.admission_generation = NEW.admission_generation
            AND publisher.publication_lease_fencing_token = NEW.publication_lease_fencing_token
            AND health.publication_lease_fencing_token = NEW.publication_lease_fencing_token
            AND health.status = 'online'
            AND health.publication_lease_expires_at > gc_mesh_capability_db_now()
            AND NEW.canonical_json::jsonb ->> 'workspaceId' = NEW.workspace_id
            AND NEW.canonical_json::jsonb ->> 'nodeId' = NEW.node_id
            AND (NEW.canonical_json::jsonb ->> 'admissionGeneration')::BIGINT = NEW.admission_generation
            AND (NEW.canonical_json::jsonb ->> 'publisherGeneration')::BIGINT = NEW.publisher_generation
            AND NEW.canonical_json::jsonb ->> 'publicationKey' = NEW.publication_key
            AND (NEW.canonical_json::jsonb ->> 'publicationLeaseFencingToken')::BIGINT = NEW.publication_lease_fencing_token
            AND NEW.canonical_json::jsonb ->> 'manifestSha256' = NEW.manifest_sha256
            AND NEW.canonical_json::jsonb ->> 'supersedesManifestSha256' IS NOT DISTINCT FROM NEW.supersedes_manifest_sha256
            AND NEW.canonical_json::jsonb ->> 'schemaVersion' = NEW.schema_version
            AND NEW.canonical_json::jsonb ->> 'createdAt' = NEW.created_at
            AND jsonb_array_length(NEW.canonical_json::jsonb -> 'entries') = NEW.entry_count
        ) THEN RAISE EXCEPTION 'mesh capability manifest publisher is not healthy' USING ERRCODE = '23514'; END IF;
        IF NEW.supersedes_manifest_sha256 IS NOT NULL THEN
          IF NOT EXISTS (
            SELECT 1 FROM mesh_capability_manifests prior
            WHERE prior.workspace_id = NEW.workspace_id AND prior.node_id = NEW.node_id
              AND prior.publisher_generation = NEW.publisher_generation
              AND prior.manifest_sha256 = NEW.supersedes_manifest_sha256
          ) OR EXISTS (
            SELECT 1 FROM mesh_capability_manifests child
            WHERE child.workspace_id = NEW.workspace_id AND child.node_id = NEW.node_id
              AND child.publisher_generation = NEW.publisher_generation
              AND child.supersedes_manifest_sha256 = NEW.supersedes_manifest_sha256
          ) THEN RAISE EXCEPTION 'mesh capability manifest supersession is not a current immutable head' USING ERRCODE = '23514'; END IF;
        ELSE
          SELECT COUNT(*) INTO active_manifest_count
          FROM mesh_capability_manifests head
          WHERE head.workspace_id = NEW.workspace_id AND head.node_id = NEW.node_id
            AND head.publisher_generation = NEW.publisher_generation
            AND NOT EXISTS (
              SELECT 1 FROM mesh_capability_manifests child
              WHERE child.workspace_id = head.workspace_id AND child.node_id = head.node_id
                AND child.publisher_generation = head.publisher_generation
                AND child.supersedes_manifest_sha256 = head.manifest_sha256
            );
          IF active_manifest_count >= 32 THEN RAISE EXCEPTION 'mesh capability active manifest limit exceeded' USING ERRCODE = '23514'; END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_mesh_capability_manifest_insert_guard
        BEFORE INSERT ON mesh_capability_manifests
        FOR EACH ROW EXECUTE FUNCTION gc_mesh_capability_manifest_guard();

      CREATE OR REPLACE FUNCTION gc_mesh_capability_entry_guard()
      RETURNS trigger AS $$
      DECLARE stored_count BIGINT; expected_count BIGINT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(
          NEW.workspace_id || ':' || NEW.node_id || ':' || NEW.publisher_generation::TEXT || ':' || NEW.manifest_sha256,
          410
        ));
        IF NEW.canonical_json::jsonb ->> 'localId' IS DISTINCT FROM NEW.local_id
          OR NEW.canonical_json::jsonb ->> 'kind' IS DISTINCT FROM NEW.kind
          OR NEW.canonical_json::jsonb ->> 'capabilityId' IS DISTINCT FROM NEW.capability_id
          OR NEW.canonical_json::jsonb ->> 'descriptorSha256' IS DISTINCT FROM NEW.descriptor_sha256
          OR NEW.canonical_json::jsonb ->> 'permissionEnvelopeSha256' IS DISTINCT FROM NEW.permission_envelope_sha256
          OR NEW.canonical_json::jsonb ->> 'entrySha256' IS DISTINCT FROM NEW.entry_sha256
          OR NEW.canonical_json::jsonb #>> '{descriptor,effectPosture}' IS DISTINCT FROM NEW.effect_posture
          OR NOT EXISTS (
            SELECT 1 FROM mesh_capability_manifests manifest
            WHERE manifest.workspace_id = NEW.workspace_id AND manifest.node_id = NEW.node_id
              AND manifest.publisher_generation = NEW.publisher_generation
              AND manifest.manifest_sha256 = NEW.manifest_sha256
              AND manifest.canonical_json::jsonb -> 'entries' @> jsonb_build_array(NEW.canonical_json::jsonb)
          )
        THEN RAISE EXCEPTION 'mesh capability manifest entry canonical binding violated' USING ERRCODE = '23514'; END IF;
        SELECT COUNT(*) INTO stored_count FROM mesh_capability_manifest_entries entry
        WHERE entry.workspace_id = NEW.workspace_id AND entry.node_id = NEW.node_id
          AND entry.publisher_generation = NEW.publisher_generation AND entry.manifest_sha256 = NEW.manifest_sha256;
        SELECT entry_count INTO expected_count FROM mesh_capability_manifests manifest
        WHERE manifest.workspace_id = NEW.workspace_id AND manifest.node_id = NEW.node_id
          AND manifest.publisher_generation = NEW.publisher_generation AND manifest.manifest_sha256 = NEW.manifest_sha256;
        IF stored_count >= expected_count THEN RAISE EXCEPTION 'mesh capability manifest entry count exceeded' USING ERRCODE = '23514'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_mesh_capability_entries_cap
        BEFORE INSERT ON mesh_capability_manifest_entries
        FOR EACH ROW EXECUTE FUNCTION gc_mesh_capability_entry_guard();

      CREATE OR REPLACE FUNCTION gc_mesh_capability_activation_guard()
      RETURNS trigger AS $$
      DECLARE active_count BIGINT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id, 408));
        SELECT COUNT(*) INTO active_count FROM mesh_capability_activations activation
        JOIN mesh_capability_publishers cap_publisher
          ON cap_publisher.workspace_id = activation.workspace_id AND cap_publisher.node_id = activation.node_id
         AND cap_publisher.publisher_generation = activation.publisher_generation
        JOIN mesh_capability_publisher_health cap_health
          ON cap_health.workspace_id = activation.workspace_id AND cap_health.node_id = activation.node_id
         AND cap_health.publisher_generation = activation.publisher_generation
        JOIN mesh_nodes cap_node ON cap_node.node_id = activation.node_id
        JOIN mesh_leases cap_lease ON cap_lease.lease_key = cap_publisher.publication_lease_key
        WHERE activation.workspace_id = NEW.workspace_id
          AND activation.capability_id <> NEW.capability_id
          AND activation.activation_revision = (SELECT MAX(latest.activation_revision)
            FROM mesh_capability_activations latest
            WHERE latest.workspace_id = activation.workspace_id AND latest.capability_id = activation.capability_id)
          AND NOT EXISTS (
            SELECT 1 FROM mesh_capability_activation_revocations revoked
            WHERE revoked.workspace_id = activation.workspace_id AND revoked.activation_id = activation.activation_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM mesh_capability_manifests child
            WHERE child.workspace_id = activation.workspace_id AND child.node_id = activation.node_id
              AND child.publisher_generation = activation.publisher_generation
              AND child.supersedes_manifest_sha256 = activation.manifest_sha256
          )
          AND cap_health.status = 'online' AND cap_health.health_generation = activation.health_generation
          AND cap_health.publication_lease_fencing_token = activation.publication_lease_fencing_token
          AND cap_publisher.publication_lease_fencing_token = activation.publication_lease_fencing_token
          AND cap_health.publication_lease_expires_at > gc_mesh_capability_db_now()
          AND activation.publisher_generation = (SELECT MAX(current.publisher_generation)
            FROM mesh_capability_publishers current
            WHERE current.workspace_id = activation.workspace_id AND current.node_id = activation.node_id)
          AND cap_node.status = 'online'
          AND (cap_publisher.mtls_required = 0 OR (
            cap_node.tls_fingerprint = cap_health.tls_fingerprint
            AND cap_publisher.tls_fingerprint = cap_health.tls_fingerprint
          ))
          AND cap_lease.holder_node_id = activation.node_id
          AND cap_lease.fencing_token = activation.publication_lease_fencing_token
          AND cap_lease.expires_at > gc_mesh_capability_db_now();
        IF active_count >= 256 THEN RAISE EXCEPTION 'mesh capability active callable workspace limit exceeded' USING ERRCODE = '23514'; END IF;
        IF NEW.activation_revision <> 1 + COALESCE((
          SELECT MAX(prior.activation_revision) FROM mesh_capability_activations prior
          WHERE prior.workspace_id = NEW.workspace_id AND prior.capability_id = NEW.capability_id
        ), 0) THEN RAISE EXCEPTION 'mesh capability activation revision is not monotonic' USING ERRCODE = '23514'; END IF;
        IF NOT EXISTS (
          SELECT 1 FROM mesh_capability_manifest_entries entry
          JOIN mesh_capability_publisher_health health
            ON health.workspace_id = entry.workspace_id AND health.node_id = entry.node_id
           AND health.publisher_generation = entry.publisher_generation
          JOIN mesh_capability_publishers publisher
            ON publisher.workspace_id = entry.workspace_id AND publisher.node_id = entry.node_id
           AND publisher.publisher_generation = entry.publisher_generation
          JOIN mesh_nodes node ON node.node_id = entry.node_id
          JOIN mesh_leases lease ON lease.lease_key = publisher.publication_lease_key
          JOIN approvals approval ON approval.approval_id = NEW.approval_id
          WHERE entry.workspace_id = NEW.workspace_id AND entry.capability_id = NEW.capability_id
            AND entry.node_id = NEW.node_id AND entry.publisher_generation = NEW.publisher_generation
            AND entry.manifest_sha256 = NEW.manifest_sha256 AND entry.kind IN ('tool', 'mcp_server')
            AND entry.entry_sha256 = NEW.entry_sha256
            AND entry.descriptor_sha256 = NEW.descriptor_sha256
            AND entry.permission_envelope_sha256 = NEW.permission_envelope_sha256
            AND entry.effect_posture = NEW.effect_posture
            AND NOT EXISTS (SELECT 1 FROM mesh_capability_manifests child
                            WHERE child.workspace_id = entry.workspace_id AND child.node_id = entry.node_id
                              AND child.publisher_generation = entry.publisher_generation
                              AND child.supersedes_manifest_sha256 = entry.manifest_sha256)
            AND health.health_generation = NEW.health_generation AND health.status = 'online'
            AND health.publication_lease_fencing_token = NEW.publication_lease_fencing_token
            AND publisher.publication_lease_fencing_token = NEW.publication_lease_fencing_token
            AND health.publication_lease_expires_at > gc_mesh_capability_db_now()
            AND publisher.publisher_generation = (SELECT MAX(current.publisher_generation)
              FROM mesh_capability_publishers current
              WHERE current.workspace_id = NEW.workspace_id AND current.node_id = NEW.node_id)
            AND node.status = 'online'
            AND (publisher.mtls_required = 0 OR (
              node.tls_fingerprint = health.tls_fingerprint
              AND publisher.tls_fingerprint = health.tls_fingerprint
            ))
            AND lease.holder_node_id = NEW.node_id AND lease.fencing_token = NEW.publication_lease_fencing_token
            AND lease.expires_at > gc_mesh_capability_db_now()
            AND approval.kind = 'mesh.capability.activate' AND approval.status = 'approved'
            AND approval.resolved_at IS NOT NULL
            AND (approval.expires_at IS NULL OR approval.expires_at::timestamptz > clock_timestamp())
            AND approval.payload_json::jsonb = jsonb_build_object(
              'workspaceId', NEW.workspace_id, 'activationId', NEW.activation_id,
              'activationRevision', NEW.activation_revision, 'requestSha256', NEW.request_sha256,
              'capabilityId', NEW.capability_id, 'manifestSha256', NEW.manifest_sha256,
              'entrySha256', NEW.entry_sha256, 'descriptorSha256', NEW.descriptor_sha256,
              'permissionEnvelopeSha256', NEW.permission_envelope_sha256, 'effectPosture', NEW.effect_posture
            )
            AND approval.linkage_json IS NOT NULL
            AND approval.linkage_json::jsonb = jsonb_strip_nulls(jsonb_build_object(
              'workspaceId', NEW.workspace_id, 'sessionId', NEW.session_id, 'turnId', NEW.turn_id
            ))
        ) THEN RAISE EXCEPTION 'mesh capability activation binding, approval, health, or lease invariant violated' USING ERRCODE = '23514'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_mesh_capability_activation_guard
        BEFORE INSERT ON mesh_capability_activations
        FOR EACH ROW EXECUTE FUNCTION gc_mesh_capability_activation_guard();

      CREATE OR REPLACE FUNCTION gc_mesh_capability_intent_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.deadline_at <= gc_mesh_capability_db_now() OR NOT EXISTS (
          SELECT 1 FROM mesh_capability_activations activation
          JOIN mesh_capability_manifest_entries entry
            ON entry.workspace_id = activation.workspace_id AND entry.node_id = activation.node_id
           AND entry.publisher_generation = activation.publisher_generation
           AND entry.manifest_sha256 = activation.manifest_sha256
           AND entry.capability_id = activation.capability_id
          JOIN mesh_capability_publisher_health health
            ON health.workspace_id = activation.workspace_id AND health.node_id = activation.node_id
           AND health.publisher_generation = activation.publisher_generation
          JOIN mesh_capability_publishers publisher
            ON publisher.workspace_id = activation.workspace_id AND publisher.node_id = activation.node_id
           AND publisher.publisher_generation = activation.publisher_generation
          JOIN mesh_nodes node ON node.node_id = activation.node_id
          JOIN mesh_leases lease ON lease.lease_key = publisher.publication_lease_key
          WHERE activation.workspace_id = NEW.workspace_id AND activation.activation_id = NEW.activation_id
            AND activation.capability_id = NEW.capability_id AND activation.node_id = NEW.node_id
            AND activation.activation_revision = (SELECT MAX(latest.activation_revision)
              FROM mesh_capability_activations latest
              WHERE latest.workspace_id = activation.workspace_id AND latest.capability_id = activation.capability_id)
            AND activation.publisher_generation = NEW.publisher_generation
            AND activation.activation_revision = NEW.activation_revision
            AND activation.health_generation = NEW.health_generation
            AND activation.publication_lease_fencing_token = NEW.publication_lease_fencing_token
            AND activation.manifest_sha256 = NEW.manifest_sha256
            AND activation.entry_sha256 = NEW.entry_sha256
            AND activation.descriptor_sha256 = NEW.descriptor_sha256
            AND activation.permission_envelope_sha256 = NEW.permission_envelope_sha256
            AND NEW.deadline_at::timestamptz <= clock_timestamp()
              + ((entry.canonical_json::jsonb #>> '{descriptor,resourceLimits,timeoutMs}')::BIGINT * interval '1 millisecond')
            AND NOT EXISTS (SELECT 1 FROM mesh_capability_activation_revocations revoked
                            WHERE revoked.workspace_id = activation.workspace_id AND revoked.activation_id = activation.activation_id)
            AND NOT EXISTS (SELECT 1 FROM mesh_capability_manifests child
                            WHERE child.workspace_id = activation.workspace_id AND child.node_id = activation.node_id
                              AND child.publisher_generation = activation.publisher_generation
                              AND child.supersedes_manifest_sha256 = activation.manifest_sha256)
            AND health.health_generation = activation.health_generation AND health.status = 'online'
            AND health.publication_lease_fencing_token = activation.publication_lease_fencing_token
            AND publisher.publication_lease_fencing_token = activation.publication_lease_fencing_token
            AND health.publication_lease_expires_at > gc_mesh_capability_db_now()
            AND activation.publisher_generation = (SELECT MAX(current.publisher_generation)
              FROM mesh_capability_publishers current
              WHERE current.workspace_id = activation.workspace_id AND current.node_id = activation.node_id)
            AND node.status = 'online'
            AND (publisher.mtls_required = 0 OR (
              node.tls_fingerprint = health.tls_fingerprint
              AND publisher.tls_fingerprint = health.tls_fingerprint
            ))
            AND lease.holder_node_id = activation.node_id
            AND lease.fencing_token = activation.publication_lease_fencing_token
            AND lease.expires_at > gc_mesh_capability_db_now()
        ) THEN RAISE EXCEPTION 'mesh capability invocation intent is not currently callable' USING ERRCODE = '23514'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_mesh_capability_intent_guard
        BEFORE INSERT ON mesh_capability_invocation_intents
        FOR EACH ROW EXECUTE FUNCTION gc_mesh_capability_intent_guard();

      CREATE OR REPLACE FUNCTION gc_mesh_capability_settlement_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM mesh_capability_invocation_intents intent
          JOIN mesh_capability_publishers publisher
            ON publisher.workspace_id = intent.workspace_id AND publisher.node_id = intent.node_id
           AND publisher.publisher_generation = intent.publisher_generation
          WHERE intent.workspace_id = NEW.workspace_id AND intent.invocation_id = NEW.invocation_id
            AND intent.publisher_generation = NEW.publisher_generation
            AND intent.publication_lease_fencing_token = NEW.publication_lease_fencing_token
            AND publisher.publication_lease_fencing_token = NEW.publication_lease_fencing_token
            AND intent.publisher_generation = (SELECT MAX(current.publisher_generation)
              FROM mesh_capability_publishers current
              WHERE current.workspace_id = intent.workspace_id AND current.node_id = intent.node_id)
        ) THEN RAISE EXCEPTION 'mesh capability settlement generation binding violated' USING ERRCODE = '23514'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_mesh_capability_settlement_guard
        BEFORE INSERT ON mesh_capability_invocation_settlements
        FOR EACH ROW EXECUTE FUNCTION gc_mesh_capability_settlement_guard();

      CREATE OR REPLACE FUNCTION gc_reject_mesh_capability_immutable_mutation()
      RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'mesh capability record is immutable' USING ERRCODE = '23514'; END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_mesh_capability_publishers_no_update BEFORE UPDATE ON mesh_capability_publishers FOR EACH ROW EXECUTE FUNCTION gc_reject_mesh_capability_immutable_mutation();
      CREATE TRIGGER trg_mesh_capability_publishers_no_delete BEFORE DELETE ON mesh_capability_publishers FOR EACH ROW EXECUTE FUNCTION gc_reject_mesh_capability_immutable_mutation();
      CREATE TRIGGER trg_mesh_capability_health_no_delete BEFORE DELETE ON mesh_capability_publisher_health FOR EACH ROW EXECUTE FUNCTION gc_reject_mesh_capability_immutable_mutation();
      CREATE TRIGGER trg_mesh_capability_manifests_no_update BEFORE UPDATE ON mesh_capability_manifests FOR EACH ROW EXECUTE FUNCTION gc_reject_mesh_capability_immutable_mutation();
      CREATE TRIGGER trg_mesh_capability_manifests_no_delete BEFORE DELETE ON mesh_capability_manifests FOR EACH ROW EXECUTE FUNCTION gc_reject_mesh_capability_immutable_mutation();
      CREATE TRIGGER trg_mesh_capability_entries_no_update BEFORE UPDATE ON mesh_capability_manifest_entries FOR EACH ROW EXECUTE FUNCTION gc_reject_mesh_capability_immutable_mutation();
      CREATE TRIGGER trg_mesh_capability_entries_no_delete BEFORE DELETE ON mesh_capability_manifest_entries FOR EACH ROW EXECUTE FUNCTION gc_reject_mesh_capability_immutable_mutation();
      CREATE TRIGGER trg_mesh_capability_activations_no_update BEFORE UPDATE ON mesh_capability_activations FOR EACH ROW EXECUTE FUNCTION gc_reject_mesh_capability_immutable_mutation();
      CREATE TRIGGER trg_mesh_capability_activations_no_delete BEFORE DELETE ON mesh_capability_activations FOR EACH ROW EXECUTE FUNCTION gc_reject_mesh_capability_immutable_mutation();
      CREATE TRIGGER trg_mesh_capability_revocations_no_update BEFORE UPDATE ON mesh_capability_activation_revocations FOR EACH ROW EXECUTE FUNCTION gc_reject_mesh_capability_immutable_mutation();
      CREATE TRIGGER trg_mesh_capability_revocations_no_delete BEFORE DELETE ON mesh_capability_activation_revocations FOR EACH ROW EXECUTE FUNCTION gc_reject_mesh_capability_immutable_mutation();
      CREATE TRIGGER trg_mesh_capability_intents_no_update BEFORE UPDATE ON mesh_capability_invocation_intents FOR EACH ROW EXECUTE FUNCTION gc_reject_mesh_capability_immutable_mutation();
      CREATE TRIGGER trg_mesh_capability_intents_no_delete BEFORE DELETE ON mesh_capability_invocation_intents FOR EACH ROW EXECUTE FUNCTION gc_reject_mesh_capability_immutable_mutation();
      CREATE TRIGGER trg_mesh_capability_settlements_no_update BEFORE UPDATE ON mesh_capability_invocation_settlements FOR EACH ROW EXECUTE FUNCTION gc_reject_mesh_capability_immutable_mutation();
      CREATE TRIGGER trg_mesh_capability_settlements_no_delete BEFORE DELETE ON mesh_capability_invocation_settlements FOR EACH ROW EXECUTE FUNCTION gc_reject_mesh_capability_immutable_mutation();
    `,
  },
  {
    version: 111,
    name: "mesh_capability_node_admission_authority",
    sql: `
      CREATE TABLE IF NOT EXISTS mesh_capability_node_admissions (
        workspace_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        admission_generation BIGINT NOT NULL CHECK(admission_generation > 0),
        join_token_sha256 TEXT NOT NULL UNIQUE CHECK(join_token_sha256 ~ '^[0-9a-f]{64}$'),
        mtls_required BIGINT NOT NULL CHECK(mtls_required IN (0, 1)),
        tls_fingerprint TEXT,
        admitted_by_actor_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        admitted_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, node_id, admission_generation),
        UNIQUE(workspace_id, idempotency_key),
        FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
        FOREIGN KEY(node_id) REFERENCES mesh_nodes(node_id) ON DELETE RESTRICT,
        FOREIGN KEY(join_token_sha256) REFERENCES mesh_join_tokens(token_hash) ON DELETE RESTRICT,
        CHECK(mtls_required = 0 OR (tls_fingerprint IS NOT NULL AND length(btrim(tls_fingerprint)) > 0))
      );

      CREATE TABLE IF NOT EXISTS mesh_capability_node_admission_revocations (
        workspace_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        admission_generation BIGINT NOT NULL CHECK(admission_generation > 0),
        reason TEXT NOT NULL,
        revoked_by_actor_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        revoked_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, node_id, admission_generation),
        UNIQUE(workspace_id, idempotency_key),
        FOREIGN KEY(workspace_id, node_id, admission_generation)
          REFERENCES mesh_capability_node_admissions(workspace_id, node_id, admission_generation) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_mesh_capability_node_admissions_current
        ON mesh_capability_node_admissions(workspace_id, node_id, admission_generation DESC);

      CREATE OR REPLACE FUNCTION gc_mesh_capability_publishers_guard()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id, 408));
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id || ':' || NEW.node_id, 409));
        IF EXISTS (
          SELECT 1 FROM mesh_capability_publishers
          WHERE workspace_id = NEW.workspace_id AND node_id = NEW.node_id
            AND publisher_generation >= NEW.publisher_generation
        ) THEN RAISE EXCEPTION 'mesh capability publisher generation must be monotonic' USING ERRCODE = '23514'; END IF;
        IF EXISTS (
          SELECT 1 FROM mesh_capability_publishers
          WHERE workspace_id = NEW.workspace_id AND node_id = NEW.node_id
            AND admission_generation > NEW.admission_generation
        ) THEN RAISE EXCEPTION 'mesh capability admission generation cannot regress' USING ERRCODE = '23514'; END IF;
        IF NOT EXISTS (
          SELECT 1 FROM mesh_nodes node
          JOIN mesh_leases lease ON lease.lease_key = NEW.publication_lease_key
          WHERE node.node_id = NEW.node_id AND node.status = 'online'
            AND lease.holder_node_id = NEW.node_id
            AND lease.fencing_token = NEW.publication_lease_fencing_token
            AND lease.expires_at > gc_mesh_capability_db_now()
            AND lease.expires_at = NEW.publication_lease_expires_at
            AND (NEW.mtls_required = 0 OR node.tls_fingerprint = NEW.tls_fingerprint)
        ) THEN RAISE EXCEPTION 'mesh capability publisher live database-clock lease invariant violated' USING ERRCODE = '23514'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_mesh_capability_has_current_node_admission(
        p_workspace_id TEXT,
        p_node_id TEXT,
        p_admission_generation BIGINT
      ) RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1 FROM mesh_capability_node_admissions admission
          WHERE admission.workspace_id = p_workspace_id AND admission.node_id = p_node_id
            AND admission.admission_generation = p_admission_generation
            AND admission.admission_generation = (
              SELECT MAX(current.admission_generation) FROM mesh_capability_node_admissions current
              WHERE current.workspace_id = admission.workspace_id AND current.node_id = admission.node_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM mesh_capability_node_admission_revocations revoked
              WHERE revoked.workspace_id = admission.workspace_id AND revoked.node_id = admission.node_id
                AND revoked.admission_generation = admission.admission_generation
            )
        );
      $$ LANGUAGE SQL STABLE;

      CREATE OR REPLACE FUNCTION gc_mesh_capability_node_admission_guard()
      RETURNS trigger AS $$
      DECLARE prior_generation BIGINT; active_count BIGINT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id, 411));
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id || ':' || NEW.node_id, 412));
        SELECT COALESCE(MAX(prior.admission_generation), 0) INTO prior_generation
        FROM mesh_capability_node_admissions prior
        WHERE prior.workspace_id = NEW.workspace_id AND prior.node_id = NEW.node_id;
        IF NEW.admission_generation <> prior_generation + 1 THEN
          RAISE EXCEPTION 'mesh capability node admission generation is not monotonic' USING ERRCODE = '23514';
        END IF;
        IF prior_generation > 0 AND NOT EXISTS (
          SELECT 1 FROM mesh_capability_node_admission_revocations revoked
          WHERE revoked.workspace_id = NEW.workspace_id AND revoked.node_id = NEW.node_id
            AND revoked.admission_generation = prior_generation
        ) THEN
          RAISE EXCEPTION 'mesh capability prior node admission must be revoked before replacement' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM mesh_join_tokens token
          WHERE token.token_hash = NEW.join_token_sha256
            AND token.used_at IS NOT NULL AND token.used_by_node_id = NEW.node_id
        ) OR NOT EXISTS (
          SELECT 1 FROM mesh_nodes node
          WHERE node.node_id = NEW.node_id AND node.status = 'online'
            AND node.tls_fingerprint IS NOT DISTINCT FROM NEW.tls_fingerprint
        ) THEN
          RAISE EXCEPTION 'mesh capability node admission token or node identity is invalid' USING ERRCODE = '23514';
        END IF;
        SELECT COUNT(*) INTO active_count
        FROM mesh_capability_node_admissions active
        WHERE active.workspace_id = NEW.workspace_id
          AND active.admission_generation = (
            SELECT MAX(current.admission_generation) FROM mesh_capability_node_admissions current
            WHERE current.workspace_id = active.workspace_id AND current.node_id = active.node_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM mesh_capability_node_admission_revocations revoked
            WHERE revoked.workspace_id = active.workspace_id AND revoked.node_id = active.node_id
              AND revoked.admission_generation = active.admission_generation
          );
        IF active_count >= 16 THEN
          RAISE EXCEPTION 'mesh capability admitted publisher workspace limit exceeded' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_mesh_capability_node_admissions_insert_guard
        BEFORE INSERT ON mesh_capability_node_admissions
        FOR EACH ROW EXECUTE FUNCTION gc_mesh_capability_node_admission_guard();

      CREATE OR REPLACE FUNCTION gc_mesh_capability_node_admission_revocation_guard()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id, 411));
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id || ':' || NEW.node_id, 412));
        IF NOT EXISTS (
          SELECT 1 FROM mesh_capability_node_admissions admission
          WHERE admission.workspace_id = NEW.workspace_id AND admission.node_id = NEW.node_id
            AND admission.admission_generation = NEW.admission_generation
            AND admission.admission_generation = (
              SELECT MAX(current.admission_generation) FROM mesh_capability_node_admissions current
              WHERE current.workspace_id = admission.workspace_id AND current.node_id = admission.node_id
            )
        ) OR EXISTS (
          SELECT 1 FROM mesh_capability_publishers publisher
          LEFT JOIN mesh_capability_publisher_health health
            ON health.workspace_id = publisher.workspace_id AND health.node_id = publisher.node_id
           AND health.publisher_generation = publisher.publisher_generation
          WHERE publisher.workspace_id = NEW.workspace_id AND publisher.node_id = NEW.node_id
            AND publisher.admission_generation = NEW.admission_generation
            AND (health.status IS NULL OR health.status NOT IN ('offline', 'revoked'))
        ) THEN
          RAISE EXCEPTION 'mesh capability node admission revocation requires the current generation and terminal publisher health' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_mesh_capability_node_admission_revocations_insert_guard
        BEFORE INSERT ON mesh_capability_node_admission_revocations
        FOR EACH ROW EXECUTE FUNCTION gc_mesh_capability_node_admission_revocation_guard();

      CREATE OR REPLACE FUNCTION gc_mesh_capability_publisher_admission_authority_guard()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id, 411));
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id || ':' || NEW.node_id, 412));
        IF NOT EXISTS (
          SELECT 1 FROM mesh_capability_node_admissions admission
          WHERE admission.workspace_id = NEW.workspace_id AND admission.node_id = NEW.node_id
            AND admission.admission_generation = NEW.admission_generation
            AND admission.mtls_required = NEW.mtls_required
            AND admission.tls_fingerprint IS NOT DISTINCT FROM NEW.tls_fingerprint
            AND gc_mesh_capability_has_current_node_admission(
              admission.workspace_id, admission.node_id, admission.admission_generation
            )
        ) THEN
          RAISE EXCEPTION 'mesh capability publisher lacks current workspace-scoped node admission authority' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_mesh_capability_00_publishers_admission_authority
        BEFORE INSERT ON mesh_capability_publishers
        FOR EACH ROW EXECUTE FUNCTION gc_mesh_capability_publisher_admission_authority_guard();

      CREATE OR REPLACE FUNCTION gc_mesh_capability_manifest_admission_authority_guard()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id || ':' || NEW.node_id, 412));
        IF NOT EXISTS (
          SELECT 1 FROM mesh_capability_publishers publisher
          WHERE publisher.workspace_id = NEW.workspace_id AND publisher.node_id = NEW.node_id
            AND publisher.publisher_generation = NEW.publisher_generation
            AND publisher.admission_generation = NEW.admission_generation
            AND gc_mesh_capability_has_current_node_admission(
              publisher.workspace_id, publisher.node_id, publisher.admission_generation
            )
        ) THEN
          RAISE EXCEPTION 'mesh capability manifest lacks current workspace-scoped node admission authority' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_mesh_capability_00_manifests_admission_authority
        BEFORE INSERT ON mesh_capability_manifests
        FOR EACH ROW EXECUTE FUNCTION gc_mesh_capability_manifest_admission_authority_guard();

      CREATE OR REPLACE FUNCTION gc_mesh_capability_activation_admission_authority_guard()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id || ':' || NEW.node_id, 412));
        IF NOT EXISTS (
          SELECT 1 FROM mesh_capability_publishers publisher
          WHERE publisher.workspace_id = NEW.workspace_id AND publisher.node_id = NEW.node_id
            AND publisher.publisher_generation = NEW.publisher_generation
            AND gc_mesh_capability_has_current_node_admission(
              publisher.workspace_id, publisher.node_id, publisher.admission_generation
            )
        ) THEN
          RAISE EXCEPTION 'mesh capability activation lacks current workspace-scoped node admission authority' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_mesh_capability_00_activations_admission_authority
        BEFORE INSERT ON mesh_capability_activations
        FOR EACH ROW EXECUTE FUNCTION gc_mesh_capability_activation_admission_authority_guard();

      CREATE OR REPLACE FUNCTION gc_mesh_capability_intent_admission_authority_guard()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id || ':' || NEW.node_id, 412));
        IF NOT EXISTS (
          SELECT 1 FROM mesh_capability_publishers publisher
          WHERE publisher.workspace_id = NEW.workspace_id AND publisher.node_id = NEW.node_id
            AND publisher.publisher_generation = NEW.publisher_generation
            AND gc_mesh_capability_has_current_node_admission(
              publisher.workspace_id, publisher.node_id, publisher.admission_generation
            )
        ) THEN
          RAISE EXCEPTION 'mesh capability invocation intent lacks current workspace-scoped node admission authority' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_mesh_capability_00_intents_admission_authority
        BEFORE INSERT ON mesh_capability_invocation_intents
        FOR EACH ROW EXECUTE FUNCTION gc_mesh_capability_intent_admission_authority_guard();

      CREATE TRIGGER trg_mesh_capability_node_admissions_no_update BEFORE UPDATE ON mesh_capability_node_admissions FOR EACH ROW EXECUTE FUNCTION gc_reject_mesh_capability_immutable_mutation();
      CREATE TRIGGER trg_mesh_capability_node_admissions_no_delete BEFORE DELETE ON mesh_capability_node_admissions FOR EACH ROW EXECUTE FUNCTION gc_reject_mesh_capability_immutable_mutation();
      CREATE TRIGGER trg_mesh_capability_node_admission_revocations_no_update BEFORE UPDATE ON mesh_capability_node_admission_revocations FOR EACH ROW EXECUTE FUNCTION gc_reject_mesh_capability_immutable_mutation();
      CREATE TRIGGER trg_mesh_capability_node_admission_revocations_no_delete BEFORE DELETE ON mesh_capability_node_admission_revocations FOR EACH ROW EXECUTE FUNCTION gc_reject_mesh_capability_immutable_mutation();
    `,
  },
  {
    version: 112,
    name: "remote_worker_admission_foundation",
    sql: `
      CREATE TABLE IF NOT EXISTS remote_worker_bootstrap_requests (
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        bootstrap_id TEXT NOT NULL CHECK(length(bootstrap_id) BETWEEN 1 AND 256),
        worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
        node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 256),
        target_worker_generation BIGINT NOT NULL CHECK(target_worker_generation > 0),
        worker_label TEXT NOT NULL CHECK(length(worker_label) BETWEEN 1 AND 160),
        platform TEXT NOT NULL CHECK(platform IN ('windows', 'linux', 'darwin')),
        architecture TEXT NOT NULL CHECK(architecture IN ('x64', 'arm64')),
        runtime_manifest_json TEXT NOT NULL CHECK(octet_length(runtime_manifest_json) <= 524288),
        runtime_manifest_sha256 TEXT NOT NULL CHECK(runtime_manifest_sha256 ~ '^[0-9a-f]{64}$'),
        allowed_workspace_count BIGINT NOT NULL CHECK(allowed_workspace_count BETWEEN 1 AND 16),
        workspace_ceiling_sha256 TEXT NOT NULL CHECK(workspace_ceiling_sha256 ~ '^[0-9a-f]{64}$'),
        capability_class_count BIGINT NOT NULL CHECK(capability_class_count BETWEEN 1 AND 9),
        capability_ceiling_sha256 TEXT NOT NULL CHECK(capability_ceiling_sha256 ~ '^[0-9a-f]{64}$'),
        bootstrap_secret_sha256 TEXT NOT NULL UNIQUE CHECK(bootstrap_secret_sha256 ~ '^[0-9a-f]{64}$'),
        expires_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(expires_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = expires_at
        ),
        created_by_actor_id TEXT NOT NULL CHECK(length(created_by_actor_id) BETWEEN 1 AND 256),
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        created_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(created_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = created_at
        ),
        PRIMARY KEY(registry_workspace_id, bootstrap_id),
        UNIQUE(registry_workspace_id, idempotency_key),
        FOREIGN KEY(registry_workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
        CHECK(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(expires_at) - gc_try_parse_timestamptz(created_at))) BETWEEN 1 AND 600),
        CHECK(jsonb_typeof(runtime_manifest_json::jsonb) = 'object'),
        CHECK(runtime_manifest_json::jsonb ?& ARRAY[
          'payload', 'payloadSha256', 'signatureAlgorithm', 'signerKeyId', 'signatureBase64Url'
        ]::TEXT[]),
        CHECK((runtime_manifest_json::jsonb - ARRAY[
          'payload', 'payloadSha256', 'signatureAlgorithm', 'signerKeyId', 'signatureBase64Url'
        ]::TEXT[]) = '{}'::JSONB),
        CHECK(jsonb_typeof(runtime_manifest_json::jsonb -> 'payload') = 'object'),
        CHECK((runtime_manifest_json::jsonb -> 'payload') ?& ARRAY[
          'schemaVersion', 'protocolVersion', 'bundleSha256', 'dependencyLockSha256',
          'vendorTreeSha256', 'launcherSha256', 'installedTreeManifestSha256',
          'installedTreeFileCount', 'platform', 'architecture'
        ]::TEXT[]),
        CHECK(((runtime_manifest_json::jsonb -> 'payload') - ARRAY[
          'schemaVersion', 'protocolVersion', 'bundleSha256', 'dependencyLockSha256',
          'vendorTreeSha256', 'launcherSha256', 'installedTreeManifestSha256',
          'installedTreeFileCount', 'platform', 'architecture'
        ]::TEXT[]) = '{}'::JSONB),
        CHECK(jsonb_typeof(runtime_manifest_json::jsonb -> 'payloadSha256') = 'string'),
        CHECK(runtime_manifest_json::jsonb ->> 'payloadSha256' ~ '^[0-9a-f]{64}$'),
        CHECK(jsonb_typeof(runtime_manifest_json::jsonb -> 'signatureAlgorithm') = 'string'),
        CHECK(jsonb_typeof(runtime_manifest_json::jsonb -> 'signerKeyId') = 'string'),
        CHECK(length(runtime_manifest_json::jsonb ->> 'signerKeyId') BETWEEN 1 AND 256),
        CHECK(jsonb_typeof(runtime_manifest_json::jsonb -> 'signatureBase64Url') = 'string'),
        CHECK(runtime_manifest_json::jsonb ->> 'signatureBase64Url' ~ '^[A-Za-z0-9_-]{85}[AQgw]$'),
        CHECK(jsonb_typeof(runtime_manifest_json::jsonb #> '{payload,bundleSha256}') = 'string'),
        CHECK(runtime_manifest_json::jsonb #>> '{payload,bundleSha256}' ~ '^[0-9a-f]{64}$'),
        CHECK(jsonb_typeof(runtime_manifest_json::jsonb #> '{payload,dependencyLockSha256}') = 'string'),
        CHECK(runtime_manifest_json::jsonb #>> '{payload,dependencyLockSha256}' ~ '^[0-9a-f]{64}$'),
        CHECK(jsonb_typeof(runtime_manifest_json::jsonb #> '{payload,vendorTreeSha256}') = 'string'),
        CHECK(runtime_manifest_json::jsonb #>> '{payload,vendorTreeSha256}' ~ '^[0-9a-f]{64}$'),
        CHECK(jsonb_typeof(runtime_manifest_json::jsonb #> '{payload,launcherSha256}') = 'string'),
        CHECK(runtime_manifest_json::jsonb #>> '{payload,launcherSha256}' ~ '^[0-9a-f]{64}$'),
        CHECK(jsonb_typeof(runtime_manifest_json::jsonb #> '{payload,installedTreeManifestSha256}') = 'string'),
        CHECK(runtime_manifest_json::jsonb #>> '{payload,installedTreeManifestSha256}' ~ '^[0-9a-f]{64}$'),
        CHECK(jsonb_typeof(runtime_manifest_json::jsonb #> '{payload,schemaVersion}') = 'string'),
        CHECK(runtime_manifest_json::jsonb #>> '{payload,schemaVersion}' = 'goatcitadel.remote-worker-runtime-manifest.v1'),
        CHECK(jsonb_typeof(runtime_manifest_json::jsonb #> '{payload,protocolVersion}') = 'string'),
        CHECK(runtime_manifest_json::jsonb #>> '{payload,protocolVersion}' = 'goatcitadel.remote-worker.v1'),
        CHECK(jsonb_typeof(runtime_manifest_json::jsonb #> '{payload,platform}') = 'string'),
        CHECK(runtime_manifest_json::jsonb #>> '{payload,platform}' = platform),
        CHECK(jsonb_typeof(runtime_manifest_json::jsonb #> '{payload,architecture}') = 'string'),
        CHECK(runtime_manifest_json::jsonb #>> '{payload,architecture}' = architecture),
        CHECK(jsonb_typeof(runtime_manifest_json::jsonb #> '{payload,installedTreeFileCount}') = 'number'),
        CHECK(runtime_manifest_json::jsonb #>> '{payload,installedTreeFileCount}' ~ '^[0-9]+$'),
        CHECK((runtime_manifest_json::jsonb #>> '{payload,installedTreeFileCount}')::NUMERIC BETWEEN 1 AND 10000),
        CHECK(runtime_manifest_json::jsonb ->> 'signatureAlgorithm' = 'ed25519')
      );

      CREATE TABLE IF NOT EXISTS remote_worker_bootstrap_allowed_workspaces (
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        bootstrap_id TEXT NOT NULL CHECK(length(bootstrap_id) BETWEEN 1 AND 256),
        allowed_workspace_id TEXT NOT NULL CHECK(length(allowed_workspace_id) BETWEEN 1 AND 256),
        PRIMARY KEY(registry_workspace_id, bootstrap_id, allowed_workspace_id),
        FOREIGN KEY(registry_workspace_id, bootstrap_id)
          REFERENCES remote_worker_bootstrap_requests(registry_workspace_id, bootstrap_id) ON DELETE RESTRICT,
        FOREIGN KEY(allowed_workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS remote_worker_bootstrap_capability_classes (
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        bootstrap_id TEXT NOT NULL CHECK(length(bootstrap_id) BETWEEN 1 AND 256),
        capability_class TEXT NOT NULL CHECK(capability_class IN (
          'durable_compute', 'gateway_inference', 'governed_tool', 'governed_code',
          'artifact_stage', 'trusted_verification', 'device_camera', 'device_location',
          'device_notification'
        )),
        PRIMARY KEY(registry_workspace_id, bootstrap_id, capability_class),
        FOREIGN KEY(registry_workspace_id, bootstrap_id)
          REFERENCES remote_worker_bootstrap_requests(registry_workspace_id, bootstrap_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS remote_worker_generations (
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
        node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 256),
        worker_generation BIGINT NOT NULL CHECK(worker_generation > 0),
        bootstrap_id TEXT NOT NULL CHECK(length(bootstrap_id) BETWEEN 1 AND 256),
        public_key_spki_sha256 TEXT NOT NULL CHECK(public_key_spki_sha256 ~ '^[0-9a-f]{64}$'),
        client_certificate_sha256 TEXT NOT NULL CHECK(client_certificate_sha256 ~ '^[0-9a-f]{64}$'),
        transport_identity_source TEXT NOT NULL CHECK(transport_identity_source IN ('native_mtls', 'trusted_terminator')),
        transport_trust_anchor_sha256 TEXT NOT NULL CHECK(transport_trust_anchor_sha256 ~ '^[0-9a-f]{64}$'),
        transport_verification_receipt_sha256 TEXT NOT NULL CHECK(transport_verification_receipt_sha256 ~ '^[0-9a-f]{64}$'),
        proof_of_possession_receipt_sha256 TEXT NOT NULL CHECK(proof_of_possession_receipt_sha256 ~ '^[0-9a-f]{64}$'),
        download_verification_receipt_sha256 TEXT NOT NULL CHECK(download_verification_receipt_sha256 ~ '^[0-9a-f]{64}$'),
        installed_tree_attestation_sha256 TEXT NOT NULL CHECK(installed_tree_attestation_sha256 ~ '^[0-9a-f]{64}$'),
        installed_tree_verification_receipt_sha256 TEXT NOT NULL CHECK(installed_tree_verification_receipt_sha256 ~ '^[0-9a-f]{64}$'),
        runtime_manifest_sha256 TEXT NOT NULL CHECK(runtime_manifest_sha256 ~ '^[0-9a-f]{64}$'),
        workspace_ceiling_sha256 TEXT NOT NULL CHECK(workspace_ceiling_sha256 ~ '^[0-9a-f]{64}$'),
        capability_ceiling_sha256 TEXT NOT NULL CHECK(capability_ceiling_sha256 ~ '^[0-9a-f]{64}$'),
        exchange_idempotency_key TEXT NOT NULL CHECK(length(exchange_idempotency_key) BETWEEN 1 AND 512),
        exchange_request_sha256 TEXT NOT NULL CHECK(exchange_request_sha256 ~ '^[0-9a-f]{64}$'),
        admitted_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(admitted_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(admitted_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = admitted_at
        ),
        PRIMARY KEY(registry_workspace_id, worker_id, worker_generation),
        UNIQUE(registry_workspace_id, bootstrap_id),
        UNIQUE(registry_workspace_id, exchange_idempotency_key),
        FOREIGN KEY(registry_workspace_id, bootstrap_id)
          REFERENCES remote_worker_bootstrap_requests(registry_workspace_id, bootstrap_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS remote_worker_runtime_credentials (
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
        worker_generation BIGINT NOT NULL CHECK(worker_generation > 0),
        credential_generation BIGINT NOT NULL CHECK(credential_generation > 0),
        credential_id TEXT NOT NULL CHECK(length(credential_id) BETWEEN 1 AND 256),
        purpose TEXT NOT NULL CHECK(purpose = 'worker_runtime'),
        token_sha256 TEXT NOT NULL UNIQUE CHECK(token_sha256 ~ '^[0-9a-f]{64}$'),
        transport_verification_receipt_sha256 TEXT NOT NULL CHECK(transport_verification_receipt_sha256 ~ '^[0-9a-f]{64}$'),
        proof_of_possession_receipt_sha256 TEXT NOT NULL CHECK(proof_of_possession_receipt_sha256 ~ '^[0-9a-f]{64}$'),
        claims_json TEXT NOT NULL CHECK(octet_length(claims_json) <= 16384),
        claims_sha256 TEXT NOT NULL CHECK(claims_sha256 ~ '^[0-9a-f]{64}$'),
        issuance_proof_sha256 TEXT NOT NULL CHECK(issuance_proof_sha256 ~ '^[0-9a-f]{64}$'),
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        issued_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(issued_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(issued_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = issued_at
        ),
        expires_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(expires_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = expires_at
        ),
        PRIMARY KEY(registry_workspace_id, worker_id, worker_generation, credential_generation),
        UNIQUE(registry_workspace_id, credential_id),
        UNIQUE(registry_workspace_id, worker_id, worker_generation, idempotency_key),
        FOREIGN KEY(registry_workspace_id, worker_id, worker_generation)
          REFERENCES remote_worker_generations(registry_workspace_id, worker_id, worker_generation) ON DELETE RESTRICT,
        CHECK(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(expires_at) - gc_try_parse_timestamptz(issued_at))) BETWEEN 1 AND 900)
      );

      CREATE TABLE IF NOT EXISTS remote_worker_generation_controls (
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
        worker_generation BIGINT NOT NULL CHECK(worker_generation > 0),
        control_revision BIGINT NOT NULL CHECK(control_revision BETWEEN 1 AND 2),
        action TEXT NOT NULL CHECK(action IN ('quarantine', 'revoke')),
        reason_code TEXT NOT NULL CHECK(reason_code ~ '^[a-z0-9]([a-z0-9._-]{0,126}[a-z0-9])?$'),
        reason_sha256 TEXT NOT NULL CHECK(reason_sha256 ~ '^[0-9a-f]{64}$'),
        actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        created_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(created_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = created_at
        ),
        PRIMARY KEY(registry_workspace_id, worker_id, worker_generation, control_revision),
        UNIQUE(registry_workspace_id, idempotency_key),
        FOREIGN KEY(registry_workspace_id, worker_id, worker_generation)
          REFERENCES remote_worker_generations(registry_workspace_id, worker_id, worker_generation) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_remote_worker_bootstraps_worker_target
        ON remote_worker_bootstrap_requests(registry_workspace_id, worker_id, target_worker_generation, expires_at);
      CREATE INDEX IF NOT EXISTS idx_remote_worker_generations_current
        ON remote_worker_generations(registry_workspace_id, worker_id, worker_generation DESC);
      CREATE INDEX IF NOT EXISTS idx_remote_worker_credentials_current
        ON remote_worker_runtime_credentials(registry_workspace_id, worker_id, worker_generation, credential_generation DESC);
      CREATE INDEX IF NOT EXISTS idx_remote_worker_controls_current
        ON remote_worker_generation_controls(registry_workspace_id, worker_id, worker_generation, control_revision DESC);

      CREATE OR REPLACE FUNCTION gc_remote_worker_bootstrap_guard()
      RETURNS trigger AS $$
      DECLARE
        prior_generation BIGINT;
        database_now TIMESTAMPTZ := clock_timestamp();
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id, 501));
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id || ':' || NEW.worker_id, 502));
        IF gc_try_parse_timestamptz(NEW.created_at) IS NULL
          OR to_char(gc_try_parse_timestamptz(NEW.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> NEW.created_at
          OR gc_try_parse_timestamptz(NEW.expires_at) IS NULL
          OR to_char(gc_try_parse_timestamptz(NEW.expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> NEW.expires_at
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.created_at) - database_now))) > 1
          OR gc_try_parse_timestamptz(NEW.expires_at) <= database_now THEN
          RAISE EXCEPTION 'remote worker bootstrap database-clock invariant violated' USING ERRCODE = '23514';
        END IF;
        IF (SELECT COUNT(*) FROM json_each(NEW.runtime_manifest_json::json)) <> 5
          OR (SELECT COUNT(DISTINCT entry.key) FROM json_each(NEW.runtime_manifest_json::json) entry) <> 5
          OR (SELECT COUNT(*) FROM json_each((NEW.runtime_manifest_json::json -> 'payload'))) <> 10
          OR (
            SELECT COUNT(DISTINCT entry.key)
            FROM json_each((NEW.runtime_manifest_json::json -> 'payload')) entry
          ) <> 10 THEN
          RAISE EXCEPTION 'remote worker runtime manifest contains duplicate or missing fields' USING ERRCODE = '23514';
        END IF;
        SELECT COALESCE(MAX(generation.worker_generation), 0) INTO prior_generation
        FROM remote_worker_generations generation
        WHERE generation.registry_workspace_id = NEW.registry_workspace_id
          AND generation.worker_id = NEW.worker_id;
        IF NEW.target_worker_generation <> prior_generation + 1 THEN
          RAISE EXCEPTION 'remote worker bootstrap target generation is not monotonic' USING ERRCODE = '23514';
        END IF;
        IF prior_generation > 0 AND NOT EXISTS (
          SELECT 1 FROM remote_worker_generation_controls control
          WHERE control.registry_workspace_id = NEW.registry_workspace_id
            AND control.worker_id = NEW.worker_id
            AND control.worker_generation = prior_generation
            AND control.action = 'revoke'
        ) THEN
          RAISE EXCEPTION 'remote worker prior generation is not revoked' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
          SELECT 1 FROM remote_worker_bootstrap_requests active
          WHERE active.registry_workspace_id = NEW.registry_workspace_id
            AND active.worker_id = NEW.worker_id
            AND active.target_worker_generation = NEW.target_worker_generation
            AND gc_try_parse_timestamptz(active.expires_at) > database_now
            AND NOT EXISTS (
              SELECT 1 FROM remote_worker_generations consumed
              WHERE consumed.registry_workspace_id = active.registry_workspace_id
                AND consumed.bootstrap_id = active.bootstrap_id
            )
        ) THEN
          RAISE EXCEPTION 'remote worker target already has a fresh bootstrap' USING ERRCODE = '23514';
        END IF;
        IF prior_generation > 0 AND EXISTS (
          SELECT 1 FROM remote_worker_generations prior
          WHERE prior.registry_workspace_id = NEW.registry_workspace_id
            AND prior.worker_id = NEW.worker_id
            AND prior.worker_generation = prior_generation
            AND prior.node_id <> NEW.node_id
        ) THEN
          RAISE EXCEPTION 'remote worker readmission node identity changed' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_remote_worker_bootstrap_insert_guard
        BEFORE INSERT ON remote_worker_bootstrap_requests
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_bootstrap_guard();

      CREATE OR REPLACE FUNCTION gc_remote_worker_bootstrap_scope_guard()
      RETURNS trigger AS $$
      DECLARE worker TEXT; scope_count BIGINT;
      BEGIN
        SELECT bootstrap.worker_id INTO worker FROM remote_worker_bootstrap_requests bootstrap
        WHERE bootstrap.registry_workspace_id = NEW.registry_workspace_id
          AND bootstrap.bootstrap_id = NEW.bootstrap_id;
        IF worker IS NULL THEN RAISE EXCEPTION 'remote worker bootstrap scope parent is unavailable' USING ERRCODE = '23514'; END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id, 501));
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id || ':' || worker, 502));
        IF EXISTS (
          SELECT 1 FROM remote_worker_generations generation
          WHERE generation.registry_workspace_id = NEW.registry_workspace_id
            AND generation.bootstrap_id = NEW.bootstrap_id
        ) THEN RAISE EXCEPTION 'remote worker consumed bootstrap scope is immutable' USING ERRCODE = '23514'; END IF;
        IF TG_TABLE_NAME = 'remote_worker_bootstrap_allowed_workspaces' THEN
          SELECT COUNT(*) INTO scope_count FROM remote_worker_bootstrap_allowed_workspaces current
          WHERE current.registry_workspace_id = NEW.registry_workspace_id AND current.bootstrap_id = NEW.bootstrap_id;
          IF scope_count >= 16 THEN RAISE EXCEPTION 'remote worker workspace ceiling exceeded' USING ERRCODE = '23514'; END IF;
          IF NEW.allowed_workspace_id <> NEW.registry_workspace_id AND NOT EXISTS (
            SELECT 1 FROM remote_worker_bootstrap_allowed_workspaces registry_scope
            WHERE registry_scope.registry_workspace_id = NEW.registry_workspace_id
              AND registry_scope.bootstrap_id = NEW.bootstrap_id
              AND registry_scope.allowed_workspace_id = NEW.registry_workspace_id
          ) THEN RAISE EXCEPTION 'remote worker registry workspace must be the first scope row' USING ERRCODE = '23514'; END IF;
        ELSE
          SELECT COUNT(*) INTO scope_count FROM remote_worker_bootstrap_capability_classes current
          WHERE current.registry_workspace_id = NEW.registry_workspace_id AND current.bootstrap_id = NEW.bootstrap_id;
          IF scope_count >= 9 THEN RAISE EXCEPTION 'remote worker capability ceiling exceeded' USING ERRCODE = '23514'; END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_remote_worker_allowed_workspace_insert_guard
        BEFORE INSERT ON remote_worker_bootstrap_allowed_workspaces
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_bootstrap_scope_guard();
      CREATE TRIGGER trg_remote_worker_capability_class_insert_guard
        BEFORE INSERT ON remote_worker_bootstrap_capability_classes
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_bootstrap_scope_guard();

      CREATE OR REPLACE FUNCTION gc_remote_worker_generation_guard()
      RETURNS trigger AS $$
      DECLARE
        prior_generation BIGINT;
        database_now TIMESTAMPTZ := clock_timestamp();
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id, 501));
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id || ':' || NEW.worker_id, 502));
        IF gc_try_parse_timestamptz(NEW.admitted_at) IS NULL
          OR to_char(gc_try_parse_timestamptz(NEW.admitted_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> NEW.admitted_at
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.admitted_at) - database_now))) > 1 THEN
          RAISE EXCEPTION 'remote worker generation database-clock invariant violated' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM remote_worker_bootstrap_requests bootstrap
          WHERE bootstrap.registry_workspace_id = NEW.registry_workspace_id
            AND bootstrap.bootstrap_id = NEW.bootstrap_id
            AND bootstrap.worker_id = NEW.worker_id
            AND bootstrap.node_id = NEW.node_id
            AND bootstrap.target_worker_generation = NEW.worker_generation
            AND bootstrap.runtime_manifest_sha256 = NEW.runtime_manifest_sha256
            AND bootstrap.workspace_ceiling_sha256 = NEW.workspace_ceiling_sha256
            AND bootstrap.capability_ceiling_sha256 = NEW.capability_ceiling_sha256
            AND gc_try_parse_timestamptz(bootstrap.expires_at) > database_now
            AND bootstrap.allowed_workspace_count = (
              SELECT COUNT(*) FROM remote_worker_bootstrap_allowed_workspaces scope
              WHERE scope.registry_workspace_id = bootstrap.registry_workspace_id
                AND scope.bootstrap_id = bootstrap.bootstrap_id
            )
            AND EXISTS (
              SELECT 1 FROM remote_worker_bootstrap_allowed_workspaces registry_scope
              WHERE registry_scope.registry_workspace_id = bootstrap.registry_workspace_id
                AND registry_scope.bootstrap_id = bootstrap.bootstrap_id
                AND registry_scope.allowed_workspace_id = bootstrap.registry_workspace_id
            )
            AND bootstrap.capability_class_count = (
              SELECT COUNT(*) FROM remote_worker_bootstrap_capability_classes scope
              WHERE scope.registry_workspace_id = bootstrap.registry_workspace_id
                AND scope.bootstrap_id = bootstrap.bootstrap_id
            )
        ) THEN RAISE EXCEPTION 'remote worker generation bootstrap binding is invalid' USING ERRCODE = '23514'; END IF;
        SELECT COALESCE(MAX(current.worker_generation), 0) INTO prior_generation
        FROM remote_worker_generations current
        WHERE current.registry_workspace_id = NEW.registry_workspace_id AND current.worker_id = NEW.worker_id;
        IF NEW.worker_generation <> prior_generation + 1 THEN
          RAISE EXCEPTION 'remote worker generation is not monotonic' USING ERRCODE = '23514';
        END IF;
        IF prior_generation > 0 AND NOT EXISTS (
          SELECT 1 FROM remote_worker_generation_controls control
          WHERE control.registry_workspace_id = NEW.registry_workspace_id
            AND control.worker_id = NEW.worker_id
            AND control.worker_generation = prior_generation
            AND control.action = 'revoke'
        ) THEN RAISE EXCEPTION 'remote worker prior generation is not revoked' USING ERRCODE = '23514'; END IF;
        IF prior_generation > 0 AND EXISTS (
          SELECT 1 FROM remote_worker_generations prior
          WHERE prior.registry_workspace_id = NEW.registry_workspace_id
            AND prior.worker_id = NEW.worker_id
            AND prior.worker_generation = prior_generation
            AND (
              prior.public_key_spki_sha256 = NEW.public_key_spki_sha256
              OR prior.client_certificate_sha256 = NEW.client_certificate_sha256
              OR prior.installed_tree_attestation_sha256 = NEW.installed_tree_attestation_sha256
            )
        ) THEN RAISE EXCEPTION 'remote worker readmission evidence did not rotate' USING ERRCODE = '23514'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_remote_worker_generation_insert_guard
        BEFORE INSERT ON remote_worker_generations
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_generation_guard();

      CREATE OR REPLACE FUNCTION gc_remote_worker_credential_guard()
      RETURNS trigger AS $$
      DECLARE
        prior_credential_generation BIGINT;
        database_now TIMESTAMPTZ := clock_timestamp();
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id, 501));
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id || ':' || NEW.worker_id, 502));
        IF gc_try_parse_timestamptz(NEW.issued_at) IS NULL
          OR to_char(gc_try_parse_timestamptz(NEW.issued_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> NEW.issued_at
          OR gc_try_parse_timestamptz(NEW.expires_at) IS NULL
          OR to_char(gc_try_parse_timestamptz(NEW.expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> NEW.expires_at
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.issued_at) - database_now))) > 1
          OR gc_try_parse_timestamptz(NEW.expires_at) <= database_now THEN
          RAISE EXCEPTION 'remote worker credential database-clock invariant violated' USING ERRCODE = '23514';
        END IF;
        IF jsonb_typeof(NEW.claims_json::jsonb) <> 'object'
          OR (SELECT COUNT(*) FROM json_each(NEW.claims_json::json)) <> 11
          OR (SELECT COUNT(DISTINCT claim.key) FROM json_each(NEW.claims_json::json) claim) <> 11
          OR (SELECT COUNT(*) FROM jsonb_object_keys(NEW.claims_json::jsonb)) <> 11
          OR NOT (NEW.claims_json::jsonb ?& ARRAY[
            'schemaVersion', 'protocolVersion', 'purpose', 'routeAccessClass',
            'registryWorkspaceId', 'workerId', 'workerGeneration', 'allowedWorkspaceIds',
            'workspaceCeilingSha256', 'capabilityClasses', 'capabilityCeilingSha256'
          ]::TEXT[])
          OR jsonb_typeof(NEW.claims_json::jsonb -> 'schemaVersion') <> 'string'
          OR NEW.claims_json::jsonb ->> 'schemaVersion' <> 'goatcitadel.remote-worker-runtime-credential-claims.v1'
          OR jsonb_typeof(NEW.claims_json::jsonb -> 'protocolVersion') <> 'string'
          OR NEW.claims_json::jsonb ->> 'protocolVersion' <> 'goatcitadel.remote-worker.v1'
          OR jsonb_typeof(NEW.claims_json::jsonb -> 'purpose') <> 'string'
          OR NEW.claims_json::jsonb ->> 'purpose' <> 'worker_runtime'
          OR jsonb_typeof(NEW.claims_json::jsonb -> 'routeAccessClass') <> 'string'
          OR NEW.claims_json::jsonb ->> 'routeAccessClass' <> 'remote-worker'
          OR jsonb_typeof(NEW.claims_json::jsonb -> 'registryWorkspaceId') <> 'string'
          OR NEW.claims_json::jsonb ->> 'registryWorkspaceId' <> NEW.registry_workspace_id
          OR jsonb_typeof(NEW.claims_json::jsonb -> 'workerId') <> 'string'
          OR NEW.claims_json::jsonb ->> 'workerId' <> NEW.worker_id
          OR jsonb_typeof(NEW.claims_json::jsonb -> 'workerGeneration') <> 'number'
          OR NEW.claims_json::jsonb ->> 'workerGeneration' !~ '^[0-9]+$'
          OR (NEW.claims_json::jsonb ->> 'workerGeneration')::BIGINT <> NEW.worker_generation
          OR jsonb_typeof(NEW.claims_json::jsonb -> 'allowedWorkspaceIds') <> 'array'
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(NEW.claims_json::jsonb -> 'allowedWorkspaceIds') AS element(value)
            WHERE jsonb_typeof(element.value) <> 'string'
          )
          OR jsonb_array_length(NEW.claims_json::jsonb -> 'allowedWorkspaceIds') <> (
            SELECT COUNT(DISTINCT value) FROM jsonb_array_elements_text(NEW.claims_json::jsonb -> 'allowedWorkspaceIds')
          )
          OR jsonb_typeof(NEW.claims_json::jsonb -> 'workspaceCeilingSha256') <> 'string'
          OR NEW.claims_json::jsonb ->> 'workspaceCeilingSha256' !~ '^[0-9a-f]{64}$'
          OR jsonb_typeof(NEW.claims_json::jsonb -> 'capabilityClasses') <> 'array'
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(NEW.claims_json::jsonb -> 'capabilityClasses') AS element(value)
            WHERE jsonb_typeof(element.value) <> 'string'
          )
          OR jsonb_array_length(NEW.claims_json::jsonb -> 'capabilityClasses') <> (
            SELECT COUNT(DISTINCT value) FROM jsonb_array_elements_text(NEW.claims_json::jsonb -> 'capabilityClasses')
          )
          OR jsonb_typeof(NEW.claims_json::jsonb -> 'capabilityCeilingSha256') <> 'string'
          OR NEW.claims_json::jsonb ->> 'capabilityCeilingSha256' !~ '^[0-9a-f]{64}$' THEN
          RAISE EXCEPTION 'remote worker credential claims shape is invalid' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM remote_worker_generations generation
          JOIN remote_worker_bootstrap_requests bootstrap
            ON bootstrap.registry_workspace_id = generation.registry_workspace_id
           AND bootstrap.bootstrap_id = generation.bootstrap_id
          WHERE generation.registry_workspace_id = NEW.registry_workspace_id
            AND generation.worker_id = NEW.worker_id
            AND generation.worker_generation = NEW.worker_generation
            AND generation.workspace_ceiling_sha256 = NEW.claims_json::jsonb ->> 'workspaceCeilingSha256'
            AND generation.capability_ceiling_sha256 = NEW.claims_json::jsonb ->> 'capabilityCeilingSha256'
            AND jsonb_array_length(NEW.claims_json::jsonb -> 'allowedWorkspaceIds') = (
              SELECT COUNT(*)
              FROM remote_worker_bootstrap_allowed_workspaces scope
              WHERE scope.registry_workspace_id = bootstrap.registry_workspace_id
                AND scope.bootstrap_id = bootstrap.bootstrap_id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(NEW.claims_json::jsonb -> 'allowedWorkspaceIds') claim_workspace
              WHERE NOT EXISTS (
                SELECT 1 FROM remote_worker_bootstrap_allowed_workspaces scope
                WHERE scope.registry_workspace_id = bootstrap.registry_workspace_id
                  AND scope.bootstrap_id = bootstrap.bootstrap_id
                  AND scope.allowed_workspace_id = claim_workspace.value
              )
            )
            AND jsonb_array_length(NEW.claims_json::jsonb -> 'capabilityClasses') = (
              SELECT COUNT(*)
              FROM remote_worker_bootstrap_capability_classes scope
              WHERE scope.registry_workspace_id = bootstrap.registry_workspace_id
                AND scope.bootstrap_id = bootstrap.bootstrap_id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(NEW.claims_json::jsonb -> 'capabilityClasses') claim_capability
              WHERE NOT EXISTS (
                SELECT 1 FROM remote_worker_bootstrap_capability_classes scope
                WHERE scope.registry_workspace_id = bootstrap.registry_workspace_id
                  AND scope.bootstrap_id = bootstrap.bootstrap_id
                  AND scope.capability_class = claim_capability.value
              )
            )
            AND generation.worker_generation = (
              SELECT MAX(current.worker_generation) FROM remote_worker_generations current
              WHERE current.registry_workspace_id = generation.registry_workspace_id
                AND current.worker_id = generation.worker_id
            )
        ) OR EXISTS (
          SELECT 1 FROM remote_worker_generation_controls control
          WHERE control.registry_workspace_id = NEW.registry_workspace_id
            AND control.worker_id = NEW.worker_id
            AND control.worker_generation = NEW.worker_generation
        ) THEN RAISE EXCEPTION 'remote worker credential generation authority is invalid' USING ERRCODE = '23514'; END IF;
        IF NEW.credential_generation = 1 AND NOT EXISTS (
          SELECT 1 FROM remote_worker_generations generation
          WHERE generation.registry_workspace_id = NEW.registry_workspace_id
            AND generation.worker_id = NEW.worker_id
            AND generation.worker_generation = NEW.worker_generation
            AND generation.exchange_idempotency_key = NEW.idempotency_key
            AND generation.exchange_request_sha256 = NEW.request_sha256
            AND generation.transport_verification_receipt_sha256 = NEW.transport_verification_receipt_sha256
            AND generation.proof_of_possession_receipt_sha256 = NEW.proof_of_possession_receipt_sha256
        ) THEN
          RAISE EXCEPTION 'remote worker initial credential exchange binding is invalid' USING ERRCODE = '23514';
        END IF;
        SELECT COALESCE(MAX(current.credential_generation), 0) INTO prior_credential_generation
        FROM remote_worker_runtime_credentials current
        WHERE current.registry_workspace_id = NEW.registry_workspace_id
          AND current.worker_id = NEW.worker_id
          AND current.worker_generation = NEW.worker_generation;
        IF NEW.credential_generation <> prior_credential_generation + 1 THEN
          RAISE EXCEPTION 'remote worker credential generation is not monotonic' USING ERRCODE = '23514';
        END IF;
        IF prior_credential_generation > 0 AND NOT EXISTS (
          SELECT 1 FROM remote_worker_runtime_credentials prior
          WHERE prior.registry_workspace_id = NEW.registry_workspace_id
            AND prior.worker_id = NEW.worker_id
            AND prior.worker_generation = NEW.worker_generation
            AND prior.credential_generation = prior_credential_generation
            AND gc_try_parse_timestamptz(prior.expires_at) > database_now
            AND prior.claims_json = NEW.claims_json
            AND prior.claims_sha256 = NEW.claims_sha256
            AND prior.transport_verification_receipt_sha256 <> NEW.transport_verification_receipt_sha256
            AND prior.proof_of_possession_receipt_sha256 <> NEW.proof_of_possession_receipt_sha256
        ) THEN RAISE EXCEPTION 'remote worker current credential is not fresh or claims changed' USING ERRCODE = '23514'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_remote_worker_credential_insert_guard
        BEFORE INSERT ON remote_worker_runtime_credentials
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_credential_guard();

      CREATE OR REPLACE FUNCTION gc_remote_worker_control_guard()
      RETURNS trigger AS $$
      DECLARE
        prior_revision BIGINT;
        prior_action TEXT;
        database_now TIMESTAMPTZ := clock_timestamp();
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id, 501));
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id || ':' || NEW.worker_id, 502));
        IF gc_try_parse_timestamptz(NEW.created_at) IS NULL
          OR to_char(gc_try_parse_timestamptz(NEW.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> NEW.created_at
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.created_at) - database_now))) > 1 THEN
          RAISE EXCEPTION 'remote worker control database-clock invariant violated' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM remote_worker_generations generation
          WHERE generation.registry_workspace_id = NEW.registry_workspace_id
            AND generation.worker_id = NEW.worker_id
            AND generation.worker_generation = NEW.worker_generation
            AND generation.worker_generation = (
              SELECT MAX(current.worker_generation) FROM remote_worker_generations current
              WHERE current.registry_workspace_id = generation.registry_workspace_id
                AND current.worker_id = generation.worker_id
            )
        ) THEN RAISE EXCEPTION 'remote worker control generation is not current' USING ERRCODE = '23514'; END IF;
        SELECT COALESCE(MAX(control.control_revision), 0) INTO prior_revision
        FROM remote_worker_generation_controls control
        WHERE control.registry_workspace_id = NEW.registry_workspace_id
          AND control.worker_id = NEW.worker_id
          AND control.worker_generation = NEW.worker_generation;
        IF NEW.control_revision <> prior_revision + 1 OR NEW.control_revision > 2 THEN
          RAISE EXCEPTION 'remote worker control revision is not monotonic' USING ERRCODE = '23514';
        END IF;
        IF prior_revision = 1 THEN
          SELECT control.action INTO prior_action FROM remote_worker_generation_controls control
          WHERE control.registry_workspace_id = NEW.registry_workspace_id
            AND control.worker_id = NEW.worker_id
            AND control.worker_generation = NEW.worker_generation
            AND control.control_revision = 1;
          IF prior_action <> 'quarantine' OR NEW.action <> 'revoke' THEN
            RAISE EXCEPTION 'remote worker revoke is the only valid terminal transition' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_remote_worker_control_insert_guard
        BEFORE INSERT ON remote_worker_generation_controls
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_control_guard();

      CREATE OR REPLACE FUNCTION gc_reject_remote_worker_immutable_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'remote worker admission records are immutable' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_remote_worker_bootstraps_no_update BEFORE UPDATE ON remote_worker_bootstrap_requests FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_immutable_mutation();
      CREATE TRIGGER trg_remote_worker_bootstraps_no_delete BEFORE DELETE ON remote_worker_bootstrap_requests FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_immutable_mutation();
      CREATE TRIGGER trg_remote_worker_allowed_workspaces_no_update BEFORE UPDATE ON remote_worker_bootstrap_allowed_workspaces FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_immutable_mutation();
      CREATE TRIGGER trg_remote_worker_allowed_workspaces_no_delete BEFORE DELETE ON remote_worker_bootstrap_allowed_workspaces FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_immutable_mutation();
      CREATE TRIGGER trg_remote_worker_capability_classes_no_update BEFORE UPDATE ON remote_worker_bootstrap_capability_classes FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_immutable_mutation();
      CREATE TRIGGER trg_remote_worker_capability_classes_no_delete BEFORE DELETE ON remote_worker_bootstrap_capability_classes FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_immutable_mutation();
      CREATE TRIGGER trg_remote_worker_generations_no_update BEFORE UPDATE ON remote_worker_generations FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_immutable_mutation();
      CREATE TRIGGER trg_remote_worker_generations_no_delete BEFORE DELETE ON remote_worker_generations FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_immutable_mutation();
      CREATE TRIGGER trg_remote_worker_credentials_no_update BEFORE UPDATE ON remote_worker_runtime_credentials FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_immutable_mutation();
      CREATE TRIGGER trg_remote_worker_credentials_no_delete BEFORE DELETE ON remote_worker_runtime_credentials FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_immutable_mutation();
      CREATE TRIGGER trg_remote_worker_controls_no_update BEFORE UPDATE ON remote_worker_generation_controls FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_immutable_mutation();
      CREATE TRIGGER trg_remote_worker_controls_no_delete BEFORE DELETE ON remote_worker_generation_controls FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_immutable_mutation();
    `,
  },
  {
    version: 113,
    name: "remote_worker_assignment_foundation",
    sql: `
      CREATE TABLE IF NOT EXISTS remote_worker_assignments (
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        assignment_id TEXT NOT NULL CHECK(length(assignment_id) BETWEEN 1 AND 256),
        execution_workspace_id TEXT NOT NULL CHECK(length(execution_workspace_id) BETWEEN 1 AND 256),
        durable_run_id TEXT NOT NULL CHECK(length(durable_run_id) BETWEEN 1 AND 256),
        task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 256),
        session_id TEXT CHECK(session_id IS NULL OR length(session_id) BETWEEN 1 AND 256),
        turn_id TEXT CHECK(turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 256),
        manifest_json TEXT NOT NULL CHECK(octet_length(manifest_json) <= 32768),
        manifest_sha256 TEXT NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
        created_by_actor_id TEXT NOT NULL CHECK(length(created_by_actor_id) BETWEEN 1 AND 256),
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        created_at TEXT NOT NULL,
        PRIMARY KEY(registry_workspace_id, assignment_id),
        UNIQUE(registry_workspace_id, idempotency_key),
        FOREIGN KEY(registry_workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
        FOREIGN KEY(execution_workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
        FOREIGN KEY(durable_run_id) REFERENCES durable_runs(run_id) ON DELETE RESTRICT,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE RESTRICT,
        FOREIGN KEY(session_id) REFERENCES chat_session_meta(session_id) ON DELETE RESTRICT,
        FOREIGN KEY(turn_id) REFERENCES chat_turn_traces(turn_id) ON DELETE RESTRICT,
        CHECK((session_id IS NULL) = (turn_id IS NULL)),
        CHECK(jsonb_typeof(manifest_json::jsonb) = 'object'),
        CHECK(manifest_json::jsonb ->> 'schemaVersion' = 'goatcitadel.remote-worker-assignment-manifest.v1'),
        CHECK(manifest_json::jsonb ->> 'protocolVersion' = 'goatcitadel.remote-worker.v1'),
        CHECK(manifest_json::jsonb ->> 'registryWorkspaceId' = registry_workspace_id),
        CHECK(manifest_json::jsonb ->> 'executionWorkspaceId' = execution_workspace_id),
        CHECK(manifest_json::jsonb ->> 'durableRunId' = durable_run_id),
        CHECK(manifest_json::jsonb ->> 'taskId' = task_id),
        CHECK((manifest_json::jsonb ->> 'sessionId') IS NOT DISTINCT FROM session_id),
        CHECK((manifest_json::jsonb ->> 'turnId') IS NOT DISTINCT FROM turn_id),
        CHECK((manifest_json::jsonb ->> 'leaseTtlSeconds')::BIGINT BETWEEN 1 AND 900),
        CHECK((manifest_json::jsonb ->> 'maxEventCount')::BIGINT BETWEEN 1 AND 10000),
        CHECK((manifest_json::jsonb ->> 'maxEventBytes')::BIGINT BETWEEN 1 AND 65536),
        CHECK((manifest_json::jsonb ->> 'eventLowWatermark')::BIGINT BETWEEN 0 AND 9999),
        CHECK((manifest_json::jsonb ->> 'eventHighWatermark')::BIGINT BETWEEN 1 AND 10000),
        CHECK((manifest_json::jsonb ->> 'eventLowWatermark')::BIGINT < (manifest_json::jsonb ->> 'eventHighWatermark')::BIGINT),
        CHECK((manifest_json::jsonb ->> 'eventHighWatermark')::BIGINT <= (manifest_json::jsonb ->> 'maxEventCount')::BIGINT),
        CHECK((manifest_json::jsonb ->> 'maxOutputBytes')::BIGINT BETWEEN 1 AND 8388608),
        CHECK((manifest_json::jsonb ->> 'maxArtifactBytes')::BIGINT BETWEEN 1 AND 67108864)
      );

      CREATE TABLE IF NOT EXISTS remote_worker_assignment_generations (
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        assignment_id TEXT NOT NULL CHECK(length(assignment_id) BETWEEN 1 AND 256),
        assignment_generation BIGINT NOT NULL CHECK(assignment_generation > 0),
        execution_workspace_id TEXT NOT NULL CHECK(length(execution_workspace_id) BETWEEN 1 AND 256),
        worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
        worker_generation BIGINT NOT NULL CHECK(worker_generation > 0),
        node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 256),
        node_admission_generation BIGINT NOT NULL CHECK(node_admission_generation > 0),
        runtime_manifest_sha256 TEXT NOT NULL CHECK(runtime_manifest_sha256 ~ '^[0-9a-f]{64}$'),
        workspace_ceiling_sha256 TEXT NOT NULL CHECK(workspace_ceiling_sha256 ~ '^[0-9a-f]{64}$'),
        capability_ceiling_sha256 TEXT NOT NULL CHECK(capability_ceiling_sha256 ~ '^[0-9a-f]{64}$'),
        dispatch_owner_id TEXT NOT NULL CHECK(length(dispatch_owner_id) BETWEEN 1 AND 256),
        durable_run_attempt BIGINT NOT NULL CHECK(durable_run_attempt > 0),
        dispatch_authority_json TEXT NOT NULL CHECK(octet_length(dispatch_authority_json) <= 8192),
        dispatch_authority_sha256 TEXT NOT NULL CHECK(dispatch_authority_sha256 ~ '^[0-9a-f]{64}$'),
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        started_at TEXT NOT NULL,
        PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation),
        UNIQUE(registry_workspace_id, idempotency_key),
        FOREIGN KEY(registry_workspace_id, assignment_id)
          REFERENCES remote_worker_assignments(registry_workspace_id, assignment_id) ON DELETE RESTRICT,
        FOREIGN KEY(registry_workspace_id, worker_id, worker_generation)
          REFERENCES remote_worker_generations(registry_workspace_id, worker_id, worker_generation) ON DELETE RESTRICT,
        FOREIGN KEY(execution_workspace_id, node_id, node_admission_generation)
          REFERENCES mesh_capability_node_admissions(workspace_id, node_id, admission_generation) ON DELETE RESTRICT,
        CHECK(jsonb_typeof(dispatch_authority_json::jsonb) = 'object'),
        CHECK(dispatch_authority_json::jsonb ->> 'schemaVersion' = 'goatcitadel.remote-worker-assignment-dispatch-authority.v1'),
        CHECK(dispatch_authority_json::jsonb ->> 'dispatchOwnerId' = dispatch_owner_id),
        CHECK((dispatch_authority_json::jsonb ->> 'durableRunAttempt')::BIGINT = durable_run_attempt)
      );

      CREATE TABLE IF NOT EXISTS remote_worker_assignment_leases (
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        assignment_id TEXT NOT NULL CHECK(length(assignment_id) BETWEEN 1 AND 256),
        assignment_generation BIGINT NOT NULL CHECK(assignment_generation > 0),
        lease_revision BIGINT NOT NULL CHECK(lease_revision > 0),
        lease_token_sha256 TEXT NOT NULL UNIQUE CHECK(lease_token_sha256 ~ '^[0-9a-f]{64}$'),
        worker_sent_through BIGINT NOT NULL CHECK(worker_sent_through BETWEEN 0 AND 10000),
        server_acknowledged_through BIGINT NOT NULL CHECK(server_acknowledged_through BETWEEN 0 AND 10000),
        parent_dispatch_authority_json TEXT NOT NULL CHECK(octet_length(parent_dispatch_authority_json) <= 8192),
        parent_dispatch_authority_sha256 TEXT NOT NULL CHECK(parent_dispatch_authority_sha256 ~ '^[0-9a-f]{64}$'),
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, lease_revision),
        UNIQUE(registry_workspace_id, idempotency_key),
        FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation)
          REFERENCES remote_worker_assignment_generations(registry_workspace_id, assignment_id, assignment_generation) ON DELETE RESTRICT,
        CHECK(server_acknowledged_through <= worker_sent_through),
        CHECK(jsonb_typeof(parent_dispatch_authority_json::jsonb) = 'object'),
        CHECK(parent_dispatch_authority_json::jsonb ->> 'schemaVersion' = 'goatcitadel.remote-worker-assignment-dispatch-authority.v1')
      );

      CREATE TABLE IF NOT EXISTS remote_worker_assignment_controls (
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        assignment_id TEXT NOT NULL CHECK(length(assignment_id) BETWEEN 1 AND 256),
        assignment_generation BIGINT NOT NULL CHECK(assignment_generation > 0),
        control_revision BIGINT NOT NULL CHECK(control_revision > 0),
        action TEXT NOT NULL CHECK(action IN ('cancel_requested', 'generation_abandoned', 'recovery_exhausted')),
        expected_lease_revision BIGINT NOT NULL CHECK(expected_lease_revision > 0),
        reason_code TEXT NOT NULL CHECK(
          length(reason_code) BETWEEN 1 AND 128
          AND reason_code ~ '^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$'
        ),
        reason_sha256 TEXT NOT NULL CHECK(reason_sha256 ~ '^[0-9a-f]{64}$'),
        actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        created_at TEXT NOT NULL,
        PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, control_revision),
        UNIQUE(registry_workspace_id, idempotency_key),
        UNIQUE(registry_workspace_id, assignment_id, assignment_generation, action),
        FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation)
          REFERENCES remote_worker_assignment_generations(registry_workspace_id, assignment_id, assignment_generation) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS remote_worker_assignment_events (
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        assignment_id TEXT NOT NULL CHECK(length(assignment_id) BETWEEN 1 AND 256),
        assignment_generation BIGINT NOT NULL CHECK(assignment_generation > 0),
        sequence BIGINT NOT NULL CHECK(sequence BETWEEN 1 AND 10000),
        event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 256),
        event_type TEXT NOT NULL CHECK(event_type IN (
          'status', 'tool_progress', 'model_progress', 'approval_wait',
          'diagnostic', 'transcript_delta', 'terminal_output'
        )),
        payload_json TEXT NOT NULL CHECK(octet_length(payload_json) <= 65536),
        payload_sha256 TEXT NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
        previous_event_sha256 TEXT NOT NULL CHECK(previous_event_sha256 ~ '^[0-9a-f]{64}$'),
        event_sha256 TEXT NOT NULL CHECK(event_sha256 ~ '^[0-9a-f]{64}$'),
        worker_sent_through BIGINT NOT NULL CHECK(worker_sent_through BETWEEN sequence AND 10000),
        received_at TEXT NOT NULL,
        PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, sequence),
        UNIQUE(registry_workspace_id, event_id),
        UNIQUE(registry_workspace_id, event_sha256),
        FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation)
          REFERENCES remote_worker_assignment_generations(registry_workspace_id, assignment_id, assignment_generation) ON DELETE RESTRICT,
        CHECK(jsonb_typeof(payload_json::jsonb) = 'object'),
        CHECK(payload_json::jsonb ->> 'schemaVersion' = 'goatcitadel.remote-worker-assignment-event.v1')
      );

      CREATE TABLE IF NOT EXISTS remote_worker_assignment_settlements (
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        assignment_id TEXT NOT NULL CHECK(length(assignment_id) BETWEEN 1 AND 256),
        assignment_generation BIGINT NOT NULL CHECK(assignment_generation > 0),
        schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.remote-worker-assignment-settlement.v1'),
        outcome TEXT NOT NULL CHECK(outcome IN ('completed', 'failed', 'cancelled')),
        origin TEXT NOT NULL CHECK(origin IN ('worker', 'gateway_recovery')),
        gateway_actor_id TEXT CHECK(gateway_actor_id IS NULL OR length(gateway_actor_id) BETWEEN 1 AND 256),
        recovery_evidence_sha256 TEXT CHECK(recovery_evidence_sha256 IS NULL OR recovery_evidence_sha256 ~ '^[0-9a-f]{64}$'),
        final_event_sequence BIGINT NOT NULL CHECK(final_event_sequence BETWEEN 0 AND 10000),
        final_event_sha256 TEXT NOT NULL CHECK(final_event_sha256 ~ '^[0-9a-f]{64}$'),
        result_sha256 TEXT CHECK(result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$'),
        output_manifest_sha256 TEXT CHECK(output_manifest_sha256 IS NULL OR output_manifest_sha256 ~ '^[0-9a-f]{64}$'),
        failure_sha256 TEXT CHECK(failure_sha256 IS NULL OR failure_sha256 ~ '^[0-9a-f]{64}$'),
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        settled_at TEXT NOT NULL,
        PRIMARY KEY(registry_workspace_id, assignment_id),
        UNIQUE(registry_workspace_id, idempotency_key),
        FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation)
          REFERENCES remote_worker_assignment_generations(registry_workspace_id, assignment_id, assignment_generation) ON DELETE RESTRICT,
        CHECK(
          (outcome = 'completed' AND result_sha256 IS NOT NULL AND output_manifest_sha256 IS NOT NULL AND failure_sha256 IS NULL)
          OR (outcome = 'failed' AND result_sha256 IS NULL AND output_manifest_sha256 IS NULL AND failure_sha256 IS NOT NULL)
          OR (outcome = 'cancelled' AND result_sha256 IS NULL AND output_manifest_sha256 IS NULL AND failure_sha256 IS NULL)
        ),
        CHECK(
          (origin = 'worker' AND gateway_actor_id IS NULL AND recovery_evidence_sha256 IS NULL)
          OR (origin = 'gateway_recovery' AND gateway_actor_id IS NOT NULL AND recovery_evidence_sha256 IS NOT NULL)
        )
      );

      CREATE TABLE IF NOT EXISTS remote_worker_assignment_materializations (
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        assignment_id TEXT NOT NULL CHECK(length(assignment_id) BETWEEN 1 AND 256),
        materialization_id TEXT NOT NULL CHECK(length(materialization_id) BETWEEN 1 AND 256),
        schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.remote-worker-assignment-materialization.v1'),
        source_kind TEXT NOT NULL CHECK(source_kind IN ('event', 'settlement')),
        source_generation BIGINT NOT NULL CHECK(source_generation > 0),
        source_sequence BIGINT CHECK(source_sequence IS NULL OR source_sequence BETWEEN 1 AND 10000),
        source_sha256 TEXT NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
        target_kind TEXT NOT NULL CHECK(target_kind IN ('chat_transcript', 'durable_run_result')),
        target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 256),
        target_sha256 TEXT NOT NULL CHECK(target_sha256 ~ '^[0-9a-f]{64}$'),
        target_owner_session_id TEXT CHECK(target_owner_session_id IS NULL OR length(target_owner_session_id) BETWEEN 1 AND 256),
        target_owner_turn_id TEXT CHECK(target_owner_turn_id IS NULL OR length(target_owner_turn_id) BETWEEN 1 AND 256),
        target_owner_durable_run_id TEXT CHECK(target_owner_durable_run_id IS NULL OR length(target_owner_durable_run_id) BETWEEN 1 AND 256),
        receipt_sha256 TEXT NOT NULL CHECK(receipt_sha256 ~ '^[0-9a-f]{64}$'),
        gateway_actor_id TEXT NOT NULL CHECK(length(gateway_actor_id) BETWEEN 1 AND 256),
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        materialized_at TEXT NOT NULL,
        PRIMARY KEY(registry_workspace_id, assignment_id, materialization_id),
        UNIQUE(registry_workspace_id, idempotency_key),
        UNIQUE(registry_workspace_id, assignment_id, source_kind, source_generation, source_sequence, target_kind),
        FOREIGN KEY(registry_workspace_id, assignment_id)
          REFERENCES remote_worker_assignments(registry_workspace_id, assignment_id) ON DELETE RESTRICT,
        FOREIGN KEY(registry_workspace_id, assignment_id, source_generation)
          REFERENCES remote_worker_assignment_generations(registry_workspace_id, assignment_id, assignment_generation) ON DELETE RESTRICT,
        CHECK(
          (source_kind = 'event' AND source_sequence IS NOT NULL AND target_kind = 'chat_transcript'
            AND target_owner_session_id IS NOT NULL AND target_owner_turn_id IS NOT NULL
            AND target_owner_durable_run_id IS NULL)
          OR (source_kind = 'settlement' AND source_sequence IS NULL AND target_kind = 'durable_run_result'
            AND target_owner_session_id IS NULL AND target_owner_turn_id IS NULL
            AND target_owner_durable_run_id IS NOT NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_remote_worker_assignment_generations_current
        ON remote_worker_assignment_generations(registry_workspace_id, assignment_id, assignment_generation DESC);
      CREATE INDEX IF NOT EXISTS idx_remote_worker_assignment_leases_current
        ON remote_worker_assignment_leases(registry_workspace_id, assignment_id, assignment_generation, lease_revision DESC);
      CREATE INDEX IF NOT EXISTS idx_remote_worker_assignment_events_chain
        ON remote_worker_assignment_events(registry_workspace_id, assignment_id, assignment_generation, sequence);
      CREATE INDEX IF NOT EXISTS idx_remote_worker_assignment_materializations_source
        ON remote_worker_assignment_materializations(registry_workspace_id, assignment_id, source_kind, source_generation, source_sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_worker_assignment_materializations_event_once
        ON remote_worker_assignment_materializations(
          registry_workspace_id, assignment_id, source_generation, source_sequence, target_kind
        ) WHERE source_kind = 'event';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_worker_assignment_materializations_settlement_once
        ON remote_worker_assignment_materializations(
          registry_workspace_id, assignment_id, source_generation, target_kind
        ) WHERE source_kind = 'settlement';

      CREATE OR REPLACE FUNCTION gc_remote_worker_assignment_lock_generation(
        registry_workspace TEXT, assignment TEXT, generation_number BIGINT
      ) RETURNS VOID AS $$
      DECLARE
        execution_workspace TEXT;
        assigned_worker TEXT;
        assigned_node TEXT;
      BEGIN
        SELECT generation.execution_workspace_id, generation.worker_id, generation.node_id
          INTO execution_workspace, assigned_worker, assigned_node
        FROM remote_worker_assignment_generations generation
        WHERE generation.registry_workspace_id = registry_workspace
          AND generation.assignment_id = assignment
          AND generation.assignment_generation = generation_number;
        IF execution_workspace IS NULL THEN
          SELECT root.execution_workspace_id INTO execution_workspace
          FROM remote_worker_assignments root
          WHERE root.registry_workspace_id = registry_workspace AND root.assignment_id = assignment;
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(execution_workspace, 411));
        PERFORM pg_advisory_xact_lock(hashtextextended(execution_workspace || ':' || COALESCE(assigned_node, ''), 412));
        PERFORM pg_advisory_xact_lock(hashtextextended(registry_workspace, 501));
        PERFORM pg_advisory_xact_lock(hashtextextended(registry_workspace || ':' || COALESCE(assigned_worker, ''), 502));
        PERFORM pg_advisory_xact_lock(hashtextextended(registry_workspace || ':' || assignment, 503));
        PERFORM pg_advisory_xact_lock(hashtextextended(registry_workspace || ':' || assignment || ':' || generation_number::TEXT, 504));
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_remote_worker_assignment_lock_parent_context(
        durable_run_key TEXT, task_key TEXT, session_key TEXT, turn_key TEXT
      ) RETURNS VOID AS $$
      BEGIN
        PERFORM 1 FROM durable_runs run WHERE run.run_id = durable_run_key FOR UPDATE;
        PERFORM 1 FROM tasks task WHERE task.task_id = task_key FOR SHARE;
        IF session_key IS NOT NULL THEN
          PERFORM 1 FROM chat_session_meta session WHERE session.session_id = session_key FOR SHARE;
          PERFORM 1 FROM chat_turn_traces turn_trace WHERE turn_trace.turn_id = turn_key FOR SHARE;
        END IF;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_remote_worker_assignment_lock_parent_by_assignment(
        registry_workspace TEXT, assignment TEXT
      ) RETURNS VOID AS $$
      DECLARE
        durable_run_key TEXT;
        task_key TEXT;
        session_key TEXT;
        turn_key TEXT;
      BEGIN
        SELECT root.durable_run_id, root.task_id, root.session_id, root.turn_id
          INTO durable_run_key, task_key, session_key, turn_key
        FROM remote_worker_assignments root
        WHERE root.registry_workspace_id = registry_workspace AND root.assignment_id = assignment;
        PERFORM gc_remote_worker_assignment_lock_parent_context(durable_run_key, task_key, session_key, turn_key);
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_remote_worker_assignment_has_live_authority(
        registry_workspace TEXT, assignment TEXT, generation_number BIGINT
      ) RETURNS BOOLEAN AS $$
      BEGIN
        PERFORM gc_remote_worker_assignment_lock_parent_by_assignment(registry_workspace, assignment);
        RETURN (
        SELECT EXISTS (
          SELECT 1 FROM remote_worker_assignment_generations generation
          JOIN remote_worker_assignments root
            ON root.registry_workspace_id = generation.registry_workspace_id
           AND root.assignment_id = generation.assignment_id
          JOIN remote_worker_generations worker
            ON worker.registry_workspace_id = generation.registry_workspace_id
           AND worker.worker_id = generation.worker_id
           AND worker.worker_generation = generation.worker_generation
          JOIN mesh_capability_node_admissions admission
            ON admission.workspace_id = generation.execution_workspace_id
           AND admission.node_id = generation.node_id
           AND admission.admission_generation = generation.node_admission_generation
          JOIN remote_worker_assignment_leases lease
            ON lease.registry_workspace_id = generation.registry_workspace_id
           AND lease.assignment_id = generation.assignment_id
           AND lease.assignment_generation = generation.assignment_generation
          JOIN durable_runs run ON run.run_id = root.durable_run_id
          WHERE generation.registry_workspace_id = registry_workspace
            AND generation.assignment_id = assignment
            AND generation.assignment_generation = generation_number
            AND worker.worker_generation = (
              SELECT MAX(current.worker_generation) FROM remote_worker_generations current
              WHERE current.registry_workspace_id = worker.registry_workspace_id AND current.worker_id = worker.worker_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM remote_worker_generation_controls controlled
              WHERE controlled.registry_workspace_id = worker.registry_workspace_id
                AND controlled.worker_id = worker.worker_id
                AND controlled.worker_generation = worker.worker_generation
            )
            AND admission.admission_generation = (
              SELECT MAX(current.admission_generation) FROM mesh_capability_node_admissions current
              WHERE current.workspace_id = admission.workspace_id AND current.node_id = admission.node_id
            )
            AND lease.lease_revision = (
              SELECT MAX(current.lease_revision) FROM remote_worker_assignment_leases current
              WHERE current.registry_workspace_id = lease.registry_workspace_id
                AND current.assignment_id = lease.assignment_id
                AND current.assignment_generation = lease.assignment_generation
            )
            AND NOT EXISTS (
              SELECT 1 FROM mesh_capability_node_admission_revocations revoked
              WHERE revoked.workspace_id = admission.workspace_id AND revoked.node_id = admission.node_id
                AND revoked.admission_generation = admission.admission_generation
            )
            AND EXISTS (
              SELECT 1 FROM tasks task
              WHERE task.task_id = root.task_id
                AND task.workspace_id = root.execution_workspace_id
                AND task.deleted_at IS NULL
            )
            AND (
              (root.session_id IS NULL AND root.turn_id IS NULL)
              OR EXISTS (
                SELECT 1 FROM chat_session_meta session
                JOIN chat_turn_traces turn ON turn.session_id = session.session_id
                WHERE session.session_id = root.session_id
                  AND session.workspace_id = root.execution_workspace_id
                  AND turn.turn_id = root.turn_id
              )
            )
            AND run.metadata_json IS NOT NULL
            AND run.metadata_json::jsonb ->> 'remoteWorkerAssignmentParentContextSha256'
              = root.manifest_json::jsonb ->> 'parentContextSha256'
            AND run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,executionWorkspaceId}'
              = root.execution_workspace_id
            AND run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,durableRunId}' = root.durable_run_id
            AND run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,taskId}' = root.task_id
            AND (run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,sessionId}') IS NOT DISTINCT FROM root.session_id
            AND (run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,turnId}') IS NOT DISTINCT FROM root.turn_id
            AND (
              SELECT COUNT(*) FROM jsonb_object_keys(
                run.metadata_json::jsonb -> 'remoteWorkerAssignmentParentContext'
              )
            ) = CASE WHEN root.session_id IS NULL THEN 4 ELSE 6 END
            AND run.status = 'running'
            AND run.attempt_count = generation.durable_run_attempt
            AND run.lease_owner_id = generation.dispatch_owner_id
            AND run.version = (lease.parent_dispatch_authority_json::jsonb ->> 'durableRunVersion')::BIGINT
            AND run.lease_expires_at = lease.parent_dispatch_authority_json::jsonb ->> 'durableRunLeaseExpiresAt'
            AND gc_try_parse_timestamptz(run.lease_expires_at) > clock_timestamp()
        ));
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_remote_worker_assignment_guard()
      RETURNS trigger AS $$
      DECLARE
        database_now TIMESTAMPTZ := clock_timestamp();
        manifest_payload JSONB := NEW.manifest_json::jsonb;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id, 501));
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id || ':' || NEW.assignment_id, 503));
        PERFORM gc_remote_worker_assignment_lock_parent_context(
          NEW.durable_run_id, NEW.task_id, NEW.session_id, NEW.turn_id
        );
        IF jsonb_typeof(manifest_payload) <> 'object'
          OR (SELECT COUNT(*) FROM json_each(NEW.manifest_json::json)) <>
            (SELECT COUNT(DISTINCT field.key) FROM json_each(NEW.manifest_json::json) field)
          OR (
            NEW.session_id IS NULL
            AND (SELECT COUNT(*) FROM jsonb_object_keys(manifest_payload)) <> 20
          )
          OR (
            NEW.session_id IS NOT NULL
            AND (SELECT COUNT(*) FROM jsonb_object_keys(manifest_payload)) <> 22
          )
          OR EXISTS (
            SELECT 1 FROM jsonb_object_keys(manifest_payload) field(key)
            WHERE field.key NOT IN (
              'schemaVersion', 'protocolVersion', 'registryWorkspaceId', 'executionWorkspaceId',
              'durableRunId', 'taskId', 'sessionId', 'turnId', 'capabilityProfileSha256',
              'contextSnapshotSha256', 'toolEffectPostureSha256', 'pathJailSha256',
              'parentContextSha256', 'requiredCapabilityClasses', 'deadlineAt', 'leaseTtlSeconds',
              'maxEventCount', 'maxEventBytes', 'eventLowWatermark', 'eventHighWatermark',
              'maxOutputBytes', 'maxArtifactBytes'
            )
          )
          OR (
            NEW.session_id IS NULL
            AND (manifest_payload ? 'sessionId' OR manifest_payload ? 'turnId')
          )
          OR (
            NEW.session_id IS NOT NULL
            AND (COALESCE(jsonb_typeof(manifest_payload -> 'sessionId'), '') <> 'string'
              OR COALESCE(jsonb_typeof(manifest_payload -> 'turnId'), '') <> 'string')
          )
          OR EXISTS (
            SELECT 1 FROM jsonb_each(manifest_payload) field(key, value)
            WHERE (
              field.key IN (
                'schemaVersion', 'protocolVersion', 'registryWorkspaceId', 'executionWorkspaceId',
                'durableRunId', 'taskId', 'sessionId', 'turnId', 'capabilityProfileSha256',
                'contextSnapshotSha256', 'toolEffectPostureSha256', 'pathJailSha256',
                'parentContextSha256', 'deadlineAt'
              )
              AND jsonb_typeof(field.value) <> 'string'
            ) OR (
              field.key IN (
                'leaseTtlSeconds', 'maxEventCount', 'maxEventBytes', 'eventLowWatermark',
                'eventHighWatermark', 'maxOutputBytes', 'maxArtifactBytes'
              )
              AND (
                jsonb_typeof(field.value) <> 'number'
                OR field.value #>> '{}' !~ '^(0|[1-9][0-9]*)$'
              )
            )
          )
          OR EXISTS (
            SELECT 1 FROM jsonb_each(manifest_payload) field(key, value)
            WHERE field.key IN (
              'capabilityProfileSha256', 'contextSnapshotSha256', 'toolEffectPostureSha256',
              'pathJailSha256', 'parentContextSha256'
            ) AND field.value #>> '{}' !~ '^[0-9a-f]{64}$'
          )
          OR gc_try_parse_timestamptz(NEW.created_at) IS NULL
          OR to_char(gc_try_parse_timestamptz(NEW.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> NEW.created_at
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.created_at) - database_now))) > 1
          OR gc_try_parse_timestamptz(manifest_payload ->> 'deadlineAt') IS NULL
          OR gc_try_parse_timestamptz(manifest_payload ->> 'deadlineAt') <= database_now
          OR jsonb_typeof(manifest_payload -> 'requiredCapabilityClasses') <> 'array'
          OR jsonb_array_length(manifest_payload -> 'requiredCapabilityClasses') NOT BETWEEN 1 AND 9
          OR NOT (manifest_payload -> 'requiredCapabilityClasses' ? 'durable_compute')
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(manifest_payload -> 'requiredCapabilityClasses') item(value)
            WHERE jsonb_typeof(item.value) <> 'string'
              OR item.value #>> '{}' NOT IN (
                'durable_compute', 'gateway_inference', 'governed_tool', 'governed_code',
                'artifact_stage', 'trusted_verification', 'device_camera', 'device_location', 'device_notification'
              )
          )
          OR jsonb_array_length(manifest_payload -> 'requiredCapabilityClasses') <> (
            SELECT COUNT(DISTINCT value) FROM jsonb_array_elements_text(manifest_payload -> 'requiredCapabilityClasses')
          )
          OR manifest_payload ->> 'parentContextSha256' !~ '^[0-9a-f]{64}$'
          OR NOT EXISTS (
            SELECT 1 FROM tasks task
            WHERE task.task_id = NEW.task_id AND task.workspace_id = NEW.execution_workspace_id
              AND task.deleted_at IS NULL
          )
          OR (NEW.session_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM chat_session_meta session
            JOIN chat_turn_traces turn ON turn.turn_id = NEW.turn_id AND turn.session_id = session.session_id
            WHERE session.session_id = NEW.session_id AND session.workspace_id = NEW.execution_workspace_id
          ))
          OR NOT EXISTS (
            SELECT 1 FROM durable_runs run
            WHERE run.run_id = NEW.durable_run_id
              AND jsonb_typeof(run.metadata_json::jsonb) = 'object'
              AND run.metadata_json::jsonb ->> 'remoteWorkerAssignmentParentContextSha256'
                = manifest_payload ->> 'parentContextSha256'
              AND run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,schemaVersion}'
                = 'goatcitadel.remote-worker-assignment-parent-context.v1'
              AND run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,executionWorkspaceId}'
                = NEW.execution_workspace_id
              AND run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,durableRunId}' = NEW.durable_run_id
              AND run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,taskId}' = NEW.task_id
              AND (run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,sessionId}')
                IS NOT DISTINCT FROM NEW.session_id
              AND (run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,turnId}')
                IS NOT DISTINCT FROM NEW.turn_id
          ) THEN
          RAISE EXCEPTION 'remote worker assignment manifest or database-clock invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_remote_worker_assignments_insert_guard
        BEFORE INSERT ON remote_worker_assignments FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_assignment_guard();

      CREATE OR REPLACE FUNCTION gc_remote_worker_assignment_generation_guard()
      RETURNS trigger AS $$
      DECLARE
        database_now TIMESTAMPTZ := clock_timestamp();
        prior_generation BIGINT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.execution_workspace_id, 411));
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.execution_workspace_id || ':' || NEW.node_id, 412));
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id, 501));
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id || ':' || NEW.worker_id, 502));
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id || ':' || NEW.assignment_id, 503));
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id || ':' || NEW.assignment_id || ':' || NEW.assignment_generation::TEXT, 504));
        PERFORM gc_remote_worker_assignment_lock_parent_by_assignment(NEW.registry_workspace_id, NEW.assignment_id);
        SELECT COALESCE(MAX(current.assignment_generation), 0) INTO prior_generation
        FROM remote_worker_assignment_generations current
        WHERE current.registry_workspace_id = NEW.registry_workspace_id AND current.assignment_id = NEW.assignment_id;
        IF NEW.assignment_generation <> prior_generation + 1
          OR (prior_generation > 0 AND NOT EXISTS (
            SELECT 1 FROM remote_worker_assignment_controls control
            WHERE control.registry_workspace_id = NEW.registry_workspace_id AND control.assignment_id = NEW.assignment_id
              AND control.assignment_generation = prior_generation AND control.action = 'generation_abandoned'
          ))
          OR (prior_generation > 0 AND EXISTS (
            SELECT 1 FROM remote_worker_assignment_controls cancelled
            WHERE cancelled.registry_workspace_id = NEW.registry_workspace_id
              AND cancelled.assignment_id = NEW.assignment_id
              AND cancelled.assignment_generation = prior_generation
              AND cancelled.action = 'cancel_requested'
          ))
          OR EXISTS (
            SELECT 1 FROM remote_worker_assignment_settlements settlement
            WHERE settlement.registry_workspace_id = NEW.registry_workspace_id AND settlement.assignment_id = NEW.assignment_id
          )
          OR gc_try_parse_timestamptz(NEW.started_at) IS NULL
          OR to_char(gc_try_parse_timestamptz(NEW.started_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> NEW.started_at
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.started_at) - database_now))) > 1
          OR NOT EXISTS (
            SELECT 1 FROM remote_worker_assignments assignment
            JOIN durable_runs run ON run.run_id = assignment.durable_run_id
            JOIN remote_worker_generations worker
              ON worker.registry_workspace_id = NEW.registry_workspace_id AND worker.worker_id = NEW.worker_id
             AND worker.worker_generation = NEW.worker_generation AND worker.node_id = NEW.node_id
            JOIN remote_worker_bootstrap_requests bootstrap
              ON bootstrap.registry_workspace_id = worker.registry_workspace_id AND bootstrap.bootstrap_id = worker.bootstrap_id
            JOIN remote_worker_bootstrap_allowed_workspaces scope
              ON scope.registry_workspace_id = bootstrap.registry_workspace_id AND scope.bootstrap_id = bootstrap.bootstrap_id
             AND scope.allowed_workspace_id = assignment.execution_workspace_id
            JOIN mesh_capability_node_admissions admission
              ON admission.workspace_id = assignment.execution_workspace_id AND admission.node_id = NEW.node_id
             AND admission.admission_generation = NEW.node_admission_generation
            WHERE assignment.registry_workspace_id = NEW.registry_workspace_id
              AND assignment.assignment_id = NEW.assignment_id
              AND assignment.execution_workspace_id = NEW.execution_workspace_id
              AND worker.runtime_manifest_sha256 = NEW.runtime_manifest_sha256
              AND worker.workspace_ceiling_sha256 = NEW.workspace_ceiling_sha256
              AND worker.capability_ceiling_sha256 = NEW.capability_ceiling_sha256
              AND worker.worker_generation = (
                SELECT MAX(current.worker_generation) FROM remote_worker_generations current
                WHERE current.registry_workspace_id = worker.registry_workspace_id AND current.worker_id = worker.worker_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM remote_worker_generation_controls worker_control
                WHERE worker_control.registry_workspace_id = worker.registry_workspace_id
                  AND worker_control.worker_id = worker.worker_id
                  AND worker_control.worker_generation = worker.worker_generation
              )
              AND admission.admission_generation = (
                SELECT MAX(current.admission_generation) FROM mesh_capability_node_admissions current
                WHERE current.workspace_id = admission.workspace_id AND current.node_id = admission.node_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM mesh_capability_node_admission_revocations revoked
                WHERE revoked.workspace_id = admission.workspace_id AND revoked.node_id = admission.node_id
                  AND revoked.admission_generation = admission.admission_generation
              )
              AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(assignment.manifest_json::jsonb -> 'requiredCapabilityClasses') required(value)
                WHERE NOT EXISTS (
                  SELECT 1 FROM remote_worker_bootstrap_capability_classes granted
                  WHERE granted.registry_workspace_id = bootstrap.registry_workspace_id
                    AND granted.bootstrap_id = bootstrap.bootstrap_id AND granted.capability_class = required.value
                )
              )
              AND EXISTS (
                SELECT 1 FROM tasks task
                WHERE task.task_id = assignment.task_id
                  AND task.workspace_id = assignment.execution_workspace_id
                  AND task.deleted_at IS NULL
              )
              AND (
                (assignment.session_id IS NULL AND assignment.turn_id IS NULL)
                OR EXISTS (
                  SELECT 1 FROM chat_session_meta session
                  JOIN chat_turn_traces turn ON turn.session_id = session.session_id
                  WHERE session.session_id = assignment.session_id
                    AND session.workspace_id = assignment.execution_workspace_id
                    AND turn.turn_id = assignment.turn_id
                )
              )
              AND run.metadata_json IS NOT NULL
              AND run.metadata_json::jsonb ->> 'remoteWorkerAssignmentParentContextSha256'
                = assignment.manifest_json::jsonb ->> 'parentContextSha256'
              AND run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,executionWorkspaceId}'
                = assignment.execution_workspace_id
              AND run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,durableRunId}'
                = assignment.durable_run_id
              AND run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,taskId}' = assignment.task_id
              AND (run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,sessionId}') IS NOT DISTINCT FROM assignment.session_id
              AND (run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,turnId}') IS NOT DISTINCT FROM assignment.turn_id
              AND (
                SELECT COUNT(*) FROM jsonb_object_keys(
                  run.metadata_json::jsonb -> 'remoteWorkerAssignmentParentContext'
                )
              ) = CASE WHEN assignment.session_id IS NULL THEN 4 ELSE 6 END
              AND run.status = 'running' AND run.attempt_count = NEW.durable_run_attempt
              AND run.lease_owner_id = NEW.dispatch_owner_id
              AND gc_try_parse_timestamptz(run.lease_expires_at) > database_now
              AND NEW.dispatch_authority_json::jsonb ->> 'durableRunId' = run.run_id
              AND (NEW.dispatch_authority_json::jsonb ->> 'durableRunVersion')::BIGINT = run.version
              AND NEW.dispatch_authority_json::jsonb ->> 'durableRunLeaseExpiresAt' = run.lease_expires_at
          ) THEN
          RAISE EXCEPTION 'remote worker assignment generation lacks current dispatch, worker, or node authority' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_remote_worker_assignment_generations_insert_guard
        BEFORE INSERT ON remote_worker_assignment_generations FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_assignment_generation_guard();

      CREATE OR REPLACE FUNCTION gc_remote_worker_assignment_lease_guard()
      RETURNS trigger AS $$
      DECLARE
        database_now TIMESTAMPTZ := clock_timestamp();
        prior_revision BIGINT;
      BEGIN
        PERFORM gc_remote_worker_assignment_lock_generation(NEW.registry_workspace_id, NEW.assignment_id, NEW.assignment_generation);
        PERFORM gc_remote_worker_assignment_lock_parent_by_assignment(NEW.registry_workspace_id, NEW.assignment_id);
        SELECT COALESCE(MAX(current.lease_revision), 0) INTO prior_revision
        FROM remote_worker_assignment_leases current
        WHERE current.registry_workspace_id = NEW.registry_workspace_id AND current.assignment_id = NEW.assignment_id
          AND current.assignment_generation = NEW.assignment_generation;
        IF NEW.lease_revision <> prior_revision + 1
          OR NOT EXISTS (
            SELECT 1 FROM remote_worker_assignment_generations generation
            JOIN remote_worker_assignments root
              ON root.registry_workspace_id = generation.registry_workspace_id
             AND root.assignment_id = generation.assignment_id
            JOIN remote_worker_generations worker
              ON worker.registry_workspace_id = generation.registry_workspace_id
             AND worker.worker_id = generation.worker_id
             AND worker.worker_generation = generation.worker_generation
            JOIN mesh_capability_node_admissions admission
              ON admission.workspace_id = generation.execution_workspace_id
             AND admission.node_id = generation.node_id
             AND admission.admission_generation = generation.node_admission_generation
            JOIN durable_runs run ON run.run_id = root.durable_run_id
            WHERE generation.registry_workspace_id = NEW.registry_workspace_id
              AND generation.assignment_id = NEW.assignment_id
              AND generation.assignment_generation = NEW.assignment_generation
              AND worker.worker_generation = (
                SELECT MAX(current.worker_generation) FROM remote_worker_generations current
                WHERE current.registry_workspace_id = worker.registry_workspace_id
                  AND current.worker_id = worker.worker_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM remote_worker_generation_controls controlled
                WHERE controlled.registry_workspace_id = worker.registry_workspace_id
                  AND controlled.worker_id = worker.worker_id
                  AND controlled.worker_generation = worker.worker_generation
              )
              AND admission.admission_generation = (
                SELECT MAX(current.admission_generation) FROM mesh_capability_node_admissions current
                WHERE current.workspace_id = admission.workspace_id AND current.node_id = admission.node_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM mesh_capability_node_admission_revocations revoked
                WHERE revoked.workspace_id = admission.workspace_id AND revoked.node_id = admission.node_id
                  AND revoked.admission_generation = admission.admission_generation
              )
              AND EXISTS (
                SELECT 1 FROM tasks task
                WHERE task.task_id = root.task_id
                  AND task.workspace_id = root.execution_workspace_id
                  AND task.deleted_at IS NULL
              )
              AND (
                (root.session_id IS NULL AND root.turn_id IS NULL)
                OR EXISTS (
                  SELECT 1 FROM chat_session_meta session
                  JOIN chat_turn_traces turn ON turn.session_id = session.session_id
                  WHERE session.session_id = root.session_id
                    AND session.workspace_id = root.execution_workspace_id
                    AND turn.turn_id = root.turn_id
                )
              )
              AND run.metadata_json IS NOT NULL
              AND run.metadata_json::jsonb ->> 'remoteWorkerAssignmentParentContextSha256'
                = root.manifest_json::jsonb ->> 'parentContextSha256'
              AND run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,executionWorkspaceId}'
                = root.execution_workspace_id
              AND run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,durableRunId}' = root.durable_run_id
              AND run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,taskId}' = root.task_id
              AND (run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,sessionId}') IS NOT DISTINCT FROM root.session_id
              AND (run.metadata_json::jsonb #>> '{remoteWorkerAssignmentParentContext,turnId}') IS NOT DISTINCT FROM root.turn_id
              AND (
                SELECT COUNT(*) FROM jsonb_object_keys(
                  run.metadata_json::jsonb -> 'remoteWorkerAssignmentParentContext'
                )
              ) = CASE WHEN root.session_id IS NULL THEN 4 ELSE 6 END
              AND run.status = 'running'
              AND run.attempt_count = generation.durable_run_attempt
              AND run.lease_owner_id = generation.dispatch_owner_id
              AND NEW.parent_dispatch_authority_json::jsonb ->> 'durableRunId' = root.durable_run_id
              AND (NEW.parent_dispatch_authority_json::jsonb ->> 'durableRunAttempt')::BIGINT = generation.durable_run_attempt
              AND NEW.parent_dispatch_authority_json::jsonb ->> 'dispatchOwnerId' = generation.dispatch_owner_id
              AND (NEW.parent_dispatch_authority_json::jsonb ->> 'durableRunVersion')::BIGINT = run.version
              AND NEW.parent_dispatch_authority_json::jsonb ->> 'durableRunLeaseExpiresAt' = run.lease_expires_at
              AND gc_try_parse_timestamptz(NEW.expires_at) <= gc_try_parse_timestamptz(run.lease_expires_at)
              AND gc_try_parse_timestamptz(run.lease_expires_at) > database_now
          )
          OR NEW.server_acknowledged_through <> COALESCE((
            SELECT MAX(event.sequence) FROM remote_worker_assignment_events event
            WHERE event.registry_workspace_id = NEW.registry_workspace_id AND event.assignment_id = NEW.assignment_id
              AND event.assignment_generation = NEW.assignment_generation
          ), 0)
          OR NEW.worker_sent_through < COALESCE((
            SELECT MAX(committed.worker_sent_through) FROM (
              SELECT prior.worker_sent_through FROM remote_worker_assignment_leases prior
              WHERE prior.registry_workspace_id = NEW.registry_workspace_id
                AND prior.assignment_id = NEW.assignment_id
                AND prior.assignment_generation = NEW.assignment_generation
              UNION ALL
              SELECT event.worker_sent_through FROM remote_worker_assignment_events event
              WHERE event.registry_workspace_id = NEW.registry_workspace_id
                AND event.assignment_id = NEW.assignment_id
                AND event.assignment_generation = NEW.assignment_generation
            ) committed
          ), 0)
          OR gc_try_parse_timestamptz(NEW.heartbeat_at) IS NULL
          OR gc_try_parse_timestamptz(NEW.expires_at) IS NULL
          OR to_char(gc_try_parse_timestamptz(NEW.heartbeat_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> NEW.heartbeat_at
          OR to_char(gc_try_parse_timestamptz(NEW.expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> NEW.expires_at
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.heartbeat_at) - database_now))) > 1
          OR gc_try_parse_timestamptz(NEW.expires_at) <= database_now
          OR NOT EXISTS (
            SELECT 1 FROM remote_worker_assignment_generations generation
            JOIN remote_worker_assignments assignment
              ON assignment.registry_workspace_id = generation.registry_workspace_id
             AND assignment.assignment_id = generation.assignment_id
            WHERE generation.registry_workspace_id = NEW.registry_workspace_id
              AND generation.assignment_id = NEW.assignment_id
              AND generation.assignment_generation = NEW.assignment_generation
              AND generation.assignment_generation = (
                SELECT MAX(current.assignment_generation) FROM remote_worker_assignment_generations current
                WHERE current.registry_workspace_id = generation.registry_workspace_id
                  AND current.assignment_id = generation.assignment_id
              )
              AND NEW.worker_sent_through <= (assignment.manifest_json::jsonb ->> 'maxEventCount')::BIGINT
              AND gc_try_parse_timestamptz(NEW.expires_at) <= gc_try_parse_timestamptz(assignment.manifest_json::jsonb ->> 'deadlineAt')
              AND EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.expires_at) - gc_try_parse_timestamptz(NEW.heartbeat_at)))
                BETWEEN 1 AND (assignment.manifest_json::jsonb ->> 'leaseTtlSeconds')::BIGINT
          )
          OR EXISTS (
            SELECT 1 FROM remote_worker_assignment_settlements settlement
            WHERE settlement.registry_workspace_id = NEW.registry_workspace_id AND settlement.assignment_id = NEW.assignment_id
          )
          OR EXISTS (
            SELECT 1 FROM remote_worker_assignment_controls control
            WHERE control.registry_workspace_id = NEW.registry_workspace_id AND control.assignment_id = NEW.assignment_id
              AND control.assignment_generation = NEW.assignment_generation
              AND control.action IN ('cancel_requested', 'generation_abandoned', 'recovery_exhausted')
          ) THEN
          RAISE EXCEPTION 'remote worker assignment lease revision or database-clock invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_remote_worker_assignment_leases_insert_guard
        BEFORE INSERT ON remote_worker_assignment_leases FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_assignment_lease_guard();

      CREATE OR REPLACE FUNCTION gc_remote_worker_assignment_control_guard()
      RETURNS trigger AS $$
      DECLARE
        database_now TIMESTAMPTZ := clock_timestamp();
        prior_revision BIGINT;
      BEGIN
        PERFORM gc_remote_worker_assignment_lock_generation(NEW.registry_workspace_id, NEW.assignment_id, NEW.assignment_generation);
        SELECT COALESCE(MAX(current.control_revision), 0) INTO prior_revision
        FROM remote_worker_assignment_controls current
        WHERE current.registry_workspace_id = NEW.registry_workspace_id AND current.assignment_id = NEW.assignment_id
          AND current.assignment_generation = NEW.assignment_generation;
        IF NEW.control_revision <> prior_revision + 1
          OR NEW.control_revision <> 1
          OR NEW.assignment_generation <> COALESCE((
            SELECT MAX(generation.assignment_generation) FROM remote_worker_assignment_generations generation
            WHERE generation.registry_workspace_id = NEW.registry_workspace_id
              AND generation.assignment_id = NEW.assignment_id
          ), 0)
          OR NEW.expected_lease_revision <> COALESCE((
            SELECT MAX(lease.lease_revision) FROM remote_worker_assignment_leases lease
            WHERE lease.registry_workspace_id = NEW.registry_workspace_id AND lease.assignment_id = NEW.assignment_id
              AND lease.assignment_generation = NEW.assignment_generation
          ), 0)
          OR (NEW.action IN ('generation_abandoned', 'recovery_exhausted') AND EXISTS (
            SELECT 1 FROM remote_worker_assignment_leases lease
            WHERE lease.registry_workspace_id = NEW.registry_workspace_id AND lease.assignment_id = NEW.assignment_id
              AND lease.assignment_generation = NEW.assignment_generation
              AND lease.lease_revision = NEW.expected_lease_revision
              AND gc_try_parse_timestamptz(lease.expires_at) > database_now
          ))
          OR EXISTS (
            SELECT 1 FROM remote_worker_assignment_settlements settlement
            WHERE settlement.registry_workspace_id = NEW.registry_workspace_id AND settlement.assignment_id = NEW.assignment_id
          )
          OR gc_try_parse_timestamptz(NEW.created_at) IS NULL
          OR to_char(gc_try_parse_timestamptz(NEW.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> NEW.created_at
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.created_at) - database_now))) > 1 THEN
          RAISE EXCEPTION 'remote worker assignment control revision or recovery invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_remote_worker_assignment_controls_insert_guard
        BEFORE INSERT ON remote_worker_assignment_controls FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_assignment_control_guard();

      CREATE OR REPLACE FUNCTION gc_remote_worker_assignment_event_guard()
      RETURNS trigger AS $$
      DECLARE
        database_now TIMESTAMPTZ := clock_timestamp();
        event_payload JSONB := NEW.payload_json::jsonb;
        event_payload_valid BOOLEAN := FALSE;
      BEGIN
        IF NEW.event_type = 'status' THEN
          event_payload_valid := (
            (SELECT COUNT(*) FROM jsonb_object_keys(event_payload)) = 3
            AND COALESCE(jsonb_typeof(event_payload -> 'phase'), '') = 'string'
            AND event_payload ->> 'phase' IN ('accepted', 'running', 'waiting', 'finishing')
            AND COALESCE(jsonb_typeof(event_payload -> 'statusSha256'), '') = 'string'
            AND event_payload ->> 'statusSha256' ~ '^[0-9a-f]{64}$'
          );
        ELSIF NEW.event_type = 'tool_progress' THEN
          event_payload_valid := (
            (SELECT COUNT(*) FROM jsonb_object_keys(event_payload)) BETWEEN 4 AND 6
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_object_keys(event_payload) field(key)
              WHERE field.key NOT IN (
                'schemaVersion', 'toolRunId', 'phase', 'toolNameSha256', 'argsSha256', 'resultSha256'
              )
            )
            AND COALESCE(jsonb_typeof(event_payload -> 'toolRunId'), '') = 'string'
            AND length(event_payload ->> 'toolRunId') BETWEEN 1 AND 256
            AND COALESCE(jsonb_typeof(event_payload -> 'phase'), '') = 'string'
            AND event_payload ->> 'phase' IN (
              'requested', 'running', 'waiting_approval', 'completed', 'failed'
            )
            AND COALESCE(jsonb_typeof(event_payload -> 'toolNameSha256'), '') = 'string'
            AND event_payload ->> 'toolNameSha256' ~ '^[0-9a-f]{64}$'
            AND (
              NOT (event_payload ? 'argsSha256')
              OR (
                jsonb_typeof(event_payload -> 'argsSha256') = 'string'
                AND event_payload ->> 'argsSha256' ~ '^[0-9a-f]{64}$'
              )
            )
            AND (
              NOT (event_payload ? 'resultSha256')
              OR (
                jsonb_typeof(event_payload -> 'resultSha256') = 'string'
                AND event_payload ->> 'resultSha256' ~ '^[0-9a-f]{64}$'
              )
            )
          );
        ELSIF NEW.event_type = 'model_progress' THEN
          event_payload_valid := (
            (SELECT COUNT(*) FROM jsonb_object_keys(event_payload)) = 5
            AND COALESCE(jsonb_typeof(event_payload -> 'inferenceRequestId'), '') = 'string'
            AND length(event_payload ->> 'inferenceRequestId') BETWEEN 1 AND 256
            AND jsonb_typeof(event_payload -> 'inferenceAttempt') = 'number'
            AND event_payload ->> 'inferenceAttempt' ~ '^[1-9][0-9]*$'
            AND (event_payload ->> 'inferenceAttempt')::NUMERIC BETWEEN 1 AND 9007199254740991
            AND COALESCE(jsonb_typeof(event_payload -> 'phase'), '') = 'string'
            AND event_payload ->> 'phase' IN ('requested', 'streaming', 'completed', 'failed')
            AND COALESCE(jsonb_typeof(event_payload -> 'modelIntentSha256'), '') = 'string'
            AND event_payload ->> 'modelIntentSha256' ~ '^[0-9a-f]{64}$'
          );
        ELSIF NEW.event_type = 'approval_wait' THEN
          event_payload_valid := (
            (SELECT COUNT(*) FROM jsonb_object_keys(event_payload)) = 4
            AND COALESCE(jsonb_typeof(event_payload -> 'approvalId'), '') = 'string'
            AND length(event_payload ->> 'approvalId') BETWEEN 1 AND 256
            AND COALESCE(jsonb_typeof(event_payload -> 'approvalKind'), '') = 'string'
            AND event_payload ->> 'approvalKind' ~ '^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$'
            AND COALESCE(jsonb_typeof(event_payload -> 'riskLevelSha256'), '') = 'string'
            AND event_payload ->> 'riskLevelSha256' ~ '^[0-9a-f]{64}$'
          );
        ELSIF NEW.event_type = 'diagnostic' THEN
          event_payload_valid := (
            (SELECT COUNT(*) FROM jsonb_object_keys(event_payload)) = 4
            AND COALESCE(jsonb_typeof(event_payload -> 'severity'), '') = 'string'
            AND event_payload ->> 'severity' IN ('info', 'warning', 'error')
            AND COALESCE(jsonb_typeof(event_payload -> 'code'), '') = 'string'
            AND event_payload ->> 'code' ~ '^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$'
            AND COALESCE(jsonb_typeof(event_payload -> 'detailSha256'), '') = 'string'
            AND event_payload ->> 'detailSha256' ~ '^[0-9a-f]{64}$'
          );
        ELSIF NEW.event_type = 'transcript_delta' THEN
          event_payload_valid := (
            (SELECT COUNT(*) FROM jsonb_object_keys(event_payload)) = 3
            AND COALESCE(jsonb_typeof(event_payload -> 'role'), '') = 'string'
            AND event_payload ->> 'role' = 'assistant'
            AND COALESCE(jsonb_typeof(event_payload -> 'text'), '') = 'string'
            AND char_length(event_payload ->> 'text') BETWEEN 1 AND 16384
            AND octet_length(event_payload ->> 'text') BETWEEN 1 AND 65536
          );
        ELSIF NEW.event_type = 'terminal_output' THEN
          event_payload_valid := (
            (SELECT COUNT(*) FROM jsonb_object_keys(event_payload)) = 4
            AND COALESCE(jsonb_typeof(event_payload -> 'stream'), '') = 'string'
            AND event_payload ->> 'stream' IN ('stdout', 'stderr')
            AND COALESCE(jsonb_typeof(event_payload -> 'chunkSha256'), '') = 'string'
            AND event_payload ->> 'chunkSha256' ~ '^[0-9a-f]{64}$'
            AND jsonb_typeof(event_payload -> 'byteLength') = 'number'
            AND event_payload ->> 'byteLength' ~ '^[1-9][0-9]*$'
            AND (event_payload ->> 'byteLength')::NUMERIC BETWEEN 1 AND 65536
          );
        END IF;
        PERFORM gc_remote_worker_assignment_lock_generation(NEW.registry_workspace_id, NEW.assignment_id, NEW.assignment_generation);
        IF NEW.sequence <> 1 + COALESCE((
            SELECT MAX(prior.sequence) FROM remote_worker_assignment_events prior
            WHERE prior.registry_workspace_id = NEW.registry_workspace_id AND prior.assignment_id = NEW.assignment_id
              AND prior.assignment_generation = NEW.assignment_generation
          ), 0)
          OR NOT gc_remote_worker_assignment_has_live_authority(
            NEW.registry_workspace_id, NEW.assignment_id, NEW.assignment_generation
          )
          OR NEW.previous_event_sha256 <> COALESCE((
            SELECT prior.event_sha256 FROM remote_worker_assignment_events prior
            WHERE prior.registry_workspace_id = NEW.registry_workspace_id AND prior.assignment_id = NEW.assignment_id
              AND prior.assignment_generation = NEW.assignment_generation AND prior.sequence = NEW.sequence - 1
          ), repeat('0', 64))
          OR NEW.worker_sent_through < COALESCE((
            SELECT MAX(committed.worker_sent_through) FROM (
              SELECT lease.worker_sent_through FROM remote_worker_assignment_leases lease
              WHERE lease.registry_workspace_id = NEW.registry_workspace_id
                AND lease.assignment_id = NEW.assignment_id
                AND lease.assignment_generation = NEW.assignment_generation
              UNION ALL
              SELECT prior.worker_sent_through FROM remote_worker_assignment_events prior
              WHERE prior.registry_workspace_id = NEW.registry_workspace_id
                AND prior.assignment_id = NEW.assignment_id
                AND prior.assignment_generation = NEW.assignment_generation
            ) committed
          ), 0)
          OR jsonb_typeof(event_payload) <> 'object'
          OR (SELECT COUNT(*) FROM json_each(NEW.payload_json::json)) <>
            (SELECT COUNT(DISTINCT field.key) FROM json_each(NEW.payload_json::json) field)
          OR COALESCE(jsonb_typeof(event_payload -> 'schemaVersion'), '') <> 'string'
          OR event_payload ->> 'schemaVersion' <> 'goatcitadel.remote-worker-assignment-event.v1'
          OR event_payload_valid IS NOT TRUE
          OR NOT EXISTS (
            SELECT 1 FROM remote_worker_assignments assignment
            JOIN remote_worker_assignment_generations generation
              ON generation.registry_workspace_id = assignment.registry_workspace_id
             AND generation.assignment_id = assignment.assignment_id
            JOIN remote_worker_assignment_leases lease
              ON lease.registry_workspace_id = generation.registry_workspace_id
             AND lease.assignment_id = generation.assignment_id
             AND lease.assignment_generation = generation.assignment_generation
            WHERE assignment.registry_workspace_id = NEW.registry_workspace_id
              AND assignment.assignment_id = NEW.assignment_id
              AND generation.assignment_generation = NEW.assignment_generation
              AND generation.assignment_generation = (
                SELECT MAX(current.assignment_generation) FROM remote_worker_assignment_generations current
                WHERE current.registry_workspace_id = generation.registry_workspace_id
                  AND current.assignment_id = generation.assignment_id
              )
              AND lease.lease_revision = (
                SELECT MAX(current.lease_revision) FROM remote_worker_assignment_leases current
                WHERE current.registry_workspace_id = lease.registry_workspace_id
                  AND current.assignment_id = lease.assignment_id
                  AND current.assignment_generation = lease.assignment_generation
              )
              AND gc_try_parse_timestamptz(lease.expires_at) > database_now
              AND NEW.sequence <= (assignment.manifest_json::jsonb ->> 'maxEventCount')::BIGINT
              AND NEW.worker_sent_through <= (assignment.manifest_json::jsonb ->> 'maxEventCount')::BIGINT
              AND COALESCE((
                SELECT SUM(octet_length(committed.payload_json))
                FROM remote_worker_assignment_events committed
                WHERE committed.registry_workspace_id = NEW.registry_workspace_id
                  AND committed.assignment_id = NEW.assignment_id
                  AND committed.assignment_generation = NEW.assignment_generation
              ), 0) + octet_length(NEW.payload_json)
                <= (assignment.manifest_json::jsonb ->> 'maxEventBytes')::BIGINT
              AND COALESCE((
                SELECT SUM(CASE
                  WHEN committed.event_type = 'terminal_output'
                    THEN (committed.payload_json::jsonb ->> 'byteLength')::BIGINT
                  WHEN committed.event_type = 'transcript_delta'
                    THEN octet_length(committed.payload_json::jsonb ->> 'text')
                  ELSE 0
                END)
                FROM remote_worker_assignment_events committed
                WHERE committed.registry_workspace_id = NEW.registry_workspace_id
                  AND committed.assignment_id = NEW.assignment_id
                  AND committed.assignment_generation = NEW.assignment_generation
              ), 0) + CASE
                WHEN NEW.event_type = 'terminal_output' THEN (NEW.payload_json::jsonb ->> 'byteLength')::BIGINT
                WHEN NEW.event_type = 'transcript_delta' THEN octet_length(NEW.payload_json::jsonb ->> 'text')
                ELSE 0
              END <= (assignment.manifest_json::jsonb ->> 'maxOutputBytes')::BIGINT
          )
          OR EXISTS (
            SELECT 1 FROM remote_worker_assignment_controls control
            WHERE control.registry_workspace_id = NEW.registry_workspace_id AND control.assignment_id = NEW.assignment_id
              AND control.assignment_generation = NEW.assignment_generation
              AND control.action IN ('cancel_requested', 'generation_abandoned', 'recovery_exhausted')
          )
          OR EXISTS (
            SELECT 1 FROM remote_worker_assignment_settlements settlement
            WHERE settlement.registry_workspace_id = NEW.registry_workspace_id AND settlement.assignment_id = NEW.assignment_id
          )
          OR gc_try_parse_timestamptz(NEW.received_at) IS NULL
          OR to_char(gc_try_parse_timestamptz(NEW.received_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> NEW.received_at
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.received_at) - database_now))) > 1 THEN
          RAISE EXCEPTION 'remote worker assignment event chain, lease, or ceiling invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_remote_worker_assignment_events_insert_guard
        BEFORE INSERT ON remote_worker_assignment_events FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_assignment_event_guard();

      CREATE OR REPLACE FUNCTION gc_remote_worker_assignment_settlement_guard()
      RETURNS trigger AS $$
      DECLARE database_now TIMESTAMPTZ := clock_timestamp();
      BEGIN
        PERFORM gc_remote_worker_assignment_lock_generation(NEW.registry_workspace_id, NEW.assignment_id, NEW.assignment_generation);
        IF (NEW.origin = 'worker' AND NOT gc_remote_worker_assignment_has_live_authority(
            NEW.registry_workspace_id, NEW.assignment_id, NEW.assignment_generation
          ))
          OR NEW.assignment_generation <> COALESCE((
            SELECT MAX(generation.assignment_generation) FROM remote_worker_assignment_generations generation
            WHERE generation.registry_workspace_id = NEW.registry_workspace_id AND generation.assignment_id = NEW.assignment_id
          ), 0)
          OR NEW.final_event_sequence <> COALESCE((
            SELECT MAX(event.sequence) FROM remote_worker_assignment_events event
            WHERE event.registry_workspace_id = NEW.registry_workspace_id AND event.assignment_id = NEW.assignment_id
              AND event.assignment_generation = NEW.assignment_generation
          ), 0)
          OR NEW.final_event_sha256 <> COALESCE((
            SELECT event.event_sha256 FROM remote_worker_assignment_events event
            WHERE event.registry_workspace_id = NEW.registry_workspace_id AND event.assignment_id = NEW.assignment_id
              AND event.assignment_generation = NEW.assignment_generation AND event.sequence = NEW.final_event_sequence
          ), repeat('0', 64))
          OR (NEW.origin = 'worker' AND NOT EXISTS (
            SELECT 1 FROM remote_worker_assignment_leases lease
            WHERE lease.registry_workspace_id = NEW.registry_workspace_id AND lease.assignment_id = NEW.assignment_id
              AND lease.assignment_generation = NEW.assignment_generation
              AND lease.lease_revision = (
                SELECT MAX(current.lease_revision) FROM remote_worker_assignment_leases current
                WHERE current.registry_workspace_id = lease.registry_workspace_id
                  AND current.assignment_id = lease.assignment_id
                  AND current.assignment_generation = lease.assignment_generation
              )
              AND gc_try_parse_timestamptz(lease.expires_at) > database_now
          ))
          OR (NEW.outcome = 'cancelled' AND NOT EXISTS (
            SELECT 1 FROM remote_worker_assignment_controls control
            WHERE control.registry_workspace_id = NEW.registry_workspace_id AND control.assignment_id = NEW.assignment_id
              AND control.assignment_generation = NEW.assignment_generation AND control.action = 'cancel_requested'
          ))
          OR (NEW.outcome IN ('completed', 'failed') AND EXISTS (
            SELECT 1 FROM remote_worker_assignment_controls control
            WHERE control.registry_workspace_id = NEW.registry_workspace_id AND control.assignment_id = NEW.assignment_id
              AND control.assignment_generation = NEW.assignment_generation AND control.action = 'cancel_requested'
          ))
          OR (NEW.origin = 'gateway_recovery' AND NOT EXISTS (
            SELECT 1 FROM remote_worker_assignment_controls control
            WHERE control.registry_workspace_id = NEW.registry_workspace_id AND control.assignment_id = NEW.assignment_id
              AND control.assignment_generation = NEW.assignment_generation
              AND control.request_sha256 = NEW.recovery_evidence_sha256
              AND (
                (NEW.outcome = 'cancelled' AND control.action = 'cancel_requested')
                OR (NEW.outcome IN ('completed', 'failed') AND control.action IN ('generation_abandoned', 'recovery_exhausted'))
              )
          ))
          OR gc_try_parse_timestamptz(NEW.settled_at) IS NULL
          OR to_char(gc_try_parse_timestamptz(NEW.settled_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> NEW.settled_at
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.settled_at) - database_now))) > 1 THEN
          RAISE EXCEPTION 'remote worker assignment settlement winner, chain, or lease invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_remote_worker_assignment_settlements_insert_guard
        BEFORE INSERT ON remote_worker_assignment_settlements FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_assignment_settlement_guard();

      CREATE OR REPLACE FUNCTION gc_remote_worker_assignment_materialization_guard()
      RETURNS trigger AS $$
      DECLARE database_now TIMESTAMPTZ := clock_timestamp();
      BEGIN
        PERFORM gc_remote_worker_assignment_lock_generation(NEW.registry_workspace_id, NEW.assignment_id, NEW.source_generation);
        IF (NEW.source_kind = 'event' AND NOT EXISTS (
            SELECT 1 FROM remote_worker_assignment_events event
            WHERE event.registry_workspace_id = NEW.registry_workspace_id AND event.assignment_id = NEW.assignment_id
              AND event.assignment_generation = NEW.source_generation AND event.sequence = NEW.source_sequence
              AND event.event_sha256 = NEW.source_sha256 AND event.event_type = 'transcript_delta'
          ))
          OR (NEW.source_kind = 'settlement' AND NOT EXISTS (
            SELECT 1 FROM remote_worker_assignment_settlements settlement
            WHERE settlement.registry_workspace_id = NEW.registry_workspace_id AND settlement.assignment_id = NEW.assignment_id
              AND settlement.assignment_generation = NEW.source_generation AND settlement.request_sha256 = NEW.source_sha256
          ))
          OR NEW.source_generation <> COALESCE((
            SELECT MAX(generation.assignment_generation) FROM remote_worker_assignment_generations generation
            WHERE generation.registry_workspace_id = NEW.registry_workspace_id
              AND generation.assignment_id = NEW.assignment_id
          ), 0)
          OR EXISTS (
            SELECT 1 FROM remote_worker_assignment_controls control
            WHERE control.registry_workspace_id = NEW.registry_workspace_id
              AND control.assignment_id = NEW.assignment_id
              AND control.assignment_generation = NEW.source_generation
              AND control.action IN ('generation_abandoned', 'recovery_exhausted')
          )
          OR NOT EXISTS (
            SELECT 1 FROM remote_worker_assignments assignment
            WHERE assignment.registry_workspace_id = NEW.registry_workspace_id
              AND assignment.assignment_id = NEW.assignment_id
              AND (
                (NEW.source_kind = 'event'
                  AND assignment.session_id = NEW.target_owner_session_id
                  AND assignment.turn_id = NEW.target_owner_turn_id)
                OR (NEW.source_kind = 'settlement'
                  AND assignment.durable_run_id = NEW.target_owner_durable_run_id)
              )
          )
          OR gc_try_parse_timestamptz(NEW.materialized_at) IS NULL
          OR to_char(gc_try_parse_timestamptz(NEW.materialized_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> NEW.materialized_at
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.materialized_at) - database_now))) > 1 THEN
          RAISE EXCEPTION 'remote worker assignment materialization source or database-clock invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_remote_worker_assignment_materializations_insert_guard
        BEFORE INSERT ON remote_worker_assignment_materializations FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_assignment_materialization_guard();

      CREATE OR REPLACE FUNCTION gc_reject_remote_worker_assignment_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'remote worker assignment records are immutable' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_remote_worker_assignments_no_update BEFORE UPDATE ON remote_worker_assignments FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_assignment_mutation();
      CREATE TRIGGER trg_remote_worker_assignments_no_delete BEFORE DELETE ON remote_worker_assignments FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_assignment_mutation();
      CREATE TRIGGER trg_remote_worker_assignment_generations_no_update BEFORE UPDATE ON remote_worker_assignment_generations FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_assignment_mutation();
      CREATE TRIGGER trg_remote_worker_assignment_generations_no_delete BEFORE DELETE ON remote_worker_assignment_generations FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_assignment_mutation();
      CREATE TRIGGER trg_remote_worker_assignment_leases_no_update BEFORE UPDATE ON remote_worker_assignment_leases FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_assignment_mutation();
      CREATE TRIGGER trg_remote_worker_assignment_leases_no_delete BEFORE DELETE ON remote_worker_assignment_leases FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_assignment_mutation();
      CREATE TRIGGER trg_remote_worker_assignment_controls_no_update BEFORE UPDATE ON remote_worker_assignment_controls FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_assignment_mutation();
      CREATE TRIGGER trg_remote_worker_assignment_controls_no_delete BEFORE DELETE ON remote_worker_assignment_controls FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_assignment_mutation();
      CREATE TRIGGER trg_remote_worker_assignment_events_no_update BEFORE UPDATE ON remote_worker_assignment_events FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_assignment_mutation();
      CREATE TRIGGER trg_remote_worker_assignment_events_no_delete BEFORE DELETE ON remote_worker_assignment_events FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_assignment_mutation();
      CREATE TRIGGER trg_remote_worker_assignment_settlements_no_update BEFORE UPDATE ON remote_worker_assignment_settlements FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_assignment_mutation();
      CREATE TRIGGER trg_remote_worker_assignment_settlements_no_delete BEFORE DELETE ON remote_worker_assignment_settlements FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_assignment_mutation();
      CREATE TRIGGER trg_remote_worker_assignment_materializations_no_update BEFORE UPDATE ON remote_worker_assignment_materializations FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_assignment_mutation();
      CREATE TRIGGER trg_remote_worker_assignment_materializations_no_delete BEFORE DELETE ON remote_worker_assignment_materializations FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_assignment_mutation();
    `,
  },
  {
    version: 114,
    name: "session_control_foundation",
    sql: `
      ALTER TABLE auth_device_requests
        ADD COLUMN IF NOT EXISTS principal_purpose TEXT NOT NULL DEFAULT 'general_companion';
      ALTER TABLE auth_device_grants
        ADD COLUMN IF NOT EXISTS principal_purpose TEXT NOT NULL DEFAULT 'general_companion';
      ALTER TABLE companion_sessions
        ADD COLUMN IF NOT EXISTS principal_purpose TEXT NOT NULL DEFAULT 'general_companion';

      CREATE TABLE IF NOT EXISTS chat_session_control_tokens (
        token_sha256 TEXT PRIMARY KEY CHECK(token_sha256 ~ '^[0-9a-f]{64}$'),
        workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
        session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
        first_request_id TEXT CHECK(first_request_id IS NULL OR length(first_request_id) BETWEEN 1 AND 256),
        created_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(created_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = created_at
        )
      );

      CREATE TABLE IF NOT EXISTS chat_session_control_requests (
        request_id TEXT PRIMARY KEY CHECK(length(request_id) BETWEEN 1 AND 256),
        workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
        session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
        companion_session_id TEXT NOT NULL CHECK(length(companion_session_id) BETWEEN 1 AND 256),
        device_grant_id TEXT NOT NULL CHECK(length(device_grant_id) BETWEEN 1 AND 256),
        client_instance_id TEXT NOT NULL CHECK(length(client_instance_id) BETWEEN 1 AND 256),
        principal_purpose TEXT NOT NULL CHECK(principal_purpose = 'session_control_client'),
        token_sha256 TEXT NOT NULL,
        requested_capabilities_json TEXT NOT NULL CHECK(requested_capabilities_json IN ('["send"]', '["send","read"]')),
        requested_capabilities_sha256 TEXT NOT NULL CHECK(requested_capabilities_sha256 ~ '^[0-9a-f]{64}$'),
        requested_generation BIGINT NOT NULL CHECK(requested_generation > 0),
        status TEXT NOT NULL CHECK(status IN ('pending', 'rejected', 'expired', 'activated', 'cancelled')),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        expires_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(expires_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = expires_at
        ),
        created_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(created_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = created_at
        ),
        decided_at TEXT CHECK(
          decided_at IS NULL OR (
            gc_try_parse_timestamptz(decided_at) IS NOT NULL
            AND to_char(gc_try_parse_timestamptz(decided_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = decided_at
          )
        ),
        decided_by_actor_id TEXT CHECK(decided_by_actor_id IS NULL OR length(decided_by_actor_id) BETWEEN 1 AND 256),
        decision_reason_code TEXT CHECK(
          decision_reason_code IS NULL OR decision_reason_code IN (
            'request_rejected', 'request_expired', 'request_cancelled', 'handoff'
          )
        ),
        activated_generation BIGINT CHECK(activated_generation IS NULL OR activated_generation > 1),
        CHECK(
          (requested_capabilities_json = '["send"]'
            AND requested_capabilities_sha256 = '700f7799ef50095f9d008c356de23c0eb9562ec753f282f2f060079da99c2d2c')
          OR (requested_capabilities_json = '["send","read"]'
            AND requested_capabilities_sha256 = 'e58895e823b5a1618273223b24cd04ca99b2f30171b687fade8ef74a27df7a14')
        ),
        FOREIGN KEY(token_sha256) REFERENCES chat_session_control_tokens(token_sha256) ON DELETE RESTRICT,
        CHECK(expires_at > created_at),
        CHECK(
          (status = 'pending' AND decided_at IS NULL AND decided_by_actor_id IS NULL
            AND decision_reason_code IS NULL AND activated_generation IS NULL)
          OR (status = 'activated' AND decided_at IS NOT NULL AND decided_at < expires_at
            AND decided_by_actor_id IS NOT NULL AND decision_reason_code = 'handoff'
            AND activated_generation = requested_generation + 1)
          OR (status = 'rejected' AND decided_at IS NOT NULL AND decided_at < expires_at
            AND decided_by_actor_id IS NOT NULL AND decision_reason_code = 'request_rejected'
            AND activated_generation IS NULL)
          OR (status = 'cancelled' AND decided_at IS NOT NULL AND decided_at < expires_at
            AND decided_by_actor_id IS NOT NULL AND decision_reason_code = 'request_cancelled'
            AND activated_generation IS NULL)
          OR (status = 'expired' AND decided_at IS NOT NULL AND decided_at >= expires_at
            AND decided_by_actor_id IS NOT NULL AND decision_reason_code = 'request_expired'
            AND activated_generation IS NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_chat_session_control_requests_session_status
        ON chat_session_control_requests(session_id, status, created_at, request_id);
      CREATE INDEX IF NOT EXISTS idx_chat_session_control_requests_companion_status
        ON chat_session_control_requests(companion_session_id, status, created_at);

      CREATE TABLE IF NOT EXISTS chat_session_control_grants (
        workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
        session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
        generation BIGINT NOT NULL CHECK(generation > 0),
        is_current BIGINT NOT NULL CHECK(is_current IN (0, 1)),
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('operator', 'external_companion')),
        lease_state TEXT NOT NULL CHECK(lease_state IN (
          'operator_active', 'external_live', 'external_stale', 'released', 'revoked', 'superseded', 'deleted'
        )),
        request_id TEXT,
        companion_session_id TEXT,
        device_grant_id TEXT,
        client_instance_id TEXT,
        principal_purpose TEXT,
        requested_capabilities_json TEXT NOT NULL CHECK(
          requested_capabilities_json IN ('[]', '["send"]', '["send","read"]')
        ),
        requested_capabilities_sha256 TEXT NOT NULL CHECK(requested_capabilities_sha256 ~ '^[0-9a-f]{64}$'),
        effective_capabilities_json TEXT NOT NULL CHECK(
          effective_capabilities_json IN ('[]', '["send"]', '["send","read"]')
        ),
        effective_capabilities_sha256 TEXT NOT NULL CHECK(effective_capabilities_sha256 ~ '^[0-9a-f]{64}$'),
        token_sha256 TEXT,
        token_expires_at TEXT,
        last_heartbeat_at TEXT,
        lease_expires_at TEXT,
        reconnect_expires_at TEXT,
        control_revision BIGINT NOT NULL CHECK(control_revision > 0),
        transition_idempotency_key TEXT NOT NULL UNIQUE CHECK(length(transition_idempotency_key) BETWEEN 1 AND 512),
        transition_request_sha256 TEXT NOT NULL CHECK(transition_request_sha256 ~ '^[0-9a-f]{64}$'),
        created_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(created_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = created_at
        ),
        updated_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(updated_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = updated_at
        ),
        terminal_at TEXT CHECK(
          terminal_at IS NULL OR (
            gc_try_parse_timestamptz(terminal_at) IS NOT NULL
            AND to_char(gc_try_parse_timestamptz(terminal_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = terminal_at
          )
        ),
        CHECK(
          (requested_capabilities_json = '[]'
            AND requested_capabilities_sha256 = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')
          OR (requested_capabilities_json = '["send"]'
            AND requested_capabilities_sha256 = '700f7799ef50095f9d008c356de23c0eb9562ec753f282f2f060079da99c2d2c')
          OR (requested_capabilities_json = '["send","read"]'
            AND requested_capabilities_sha256 = 'e58895e823b5a1618273223b24cd04ca99b2f30171b687fade8ef74a27df7a14')
        ),
        CHECK(
          (effective_capabilities_json = '[]'
            AND effective_capabilities_sha256 = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')
          OR (effective_capabilities_json = '["send"]'
            AND effective_capabilities_sha256 = '700f7799ef50095f9d008c356de23c0eb9562ec753f282f2f060079da99c2d2c')
          OR (effective_capabilities_json = '["send","read"]'
            AND effective_capabilities_sha256 = 'e58895e823b5a1618273223b24cd04ca99b2f30171b687fade8ef74a27df7a14')
        ),
        PRIMARY KEY(session_id, generation),
        FOREIGN KEY(request_id) REFERENCES chat_session_control_requests(request_id) ON DELETE RESTRICT,
        FOREIGN KEY(token_sha256) REFERENCES chat_session_control_tokens(token_sha256) ON DELETE RESTRICT,
        CHECK(updated_at >= created_at),
        CHECK(
          (is_current = 1 AND terminal_at IS NULL AND lease_state IN ('operator_active', 'external_live', 'external_stale'))
          OR (is_current = 0 AND terminal_at IS NOT NULL AND lease_state IN ('released', 'revoked', 'superseded', 'deleted'))
        ),
        CHECK(
          (owner_kind = 'operator' AND request_id IS NULL AND companion_session_id IS NULL
            AND device_grant_id IS NULL AND client_instance_id IS NULL AND principal_purpose IS NULL
            AND requested_capabilities_json = '[]' AND effective_capabilities_json = '[]'
            AND token_sha256 IS NULL AND token_expires_at IS NULL AND last_heartbeat_at IS NULL
            AND lease_expires_at IS NULL AND reconnect_expires_at IS NULL)
          OR (owner_kind = 'external_companion' AND generation >= 2 AND request_id IS NOT NULL
            AND length(companion_session_id) BETWEEN 1 AND 256 AND length(device_grant_id) BETWEEN 1 AND 256
            AND length(client_instance_id) BETWEEN 1 AND 256 AND principal_purpose = 'session_control_client'
            AND requested_capabilities_json IN ('["send"]', '["send","read"]')
            AND effective_capabilities_json IN ('["send"]', '["send","read"]')
            AND token_sha256 IS NOT NULL AND token_expires_at IS NOT NULL AND last_heartbeat_at IS NOT NULL
            AND lease_expires_at IS NOT NULL AND reconnect_expires_at IS NOT NULL
            AND lease_expires_at > last_heartbeat_at AND reconnect_expires_at > lease_expires_at)
        )
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_session_control_grants_one_current
        ON chat_session_control_grants(session_id) WHERE is_current = 1;
      CREATE INDEX IF NOT EXISTS idx_chat_session_control_grants_workspace_current
        ON chat_session_control_grants(workspace_id, is_current, updated_at DESC, session_id);
      CREATE INDEX IF NOT EXISTS idx_chat_session_control_grants_companion_current
        ON chat_session_control_grants(companion_session_id, is_current, session_id);
      CREATE INDEX IF NOT EXISTS idx_chat_session_control_grants_device_current
        ON chat_session_control_grants(device_grant_id, is_current, session_id);

      CREATE TABLE IF NOT EXISTS chat_session_control_events (
        event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 256),
        workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
        session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
        event_sequence BIGINT NOT NULL CHECK(event_sequence > 0),
        request_id TEXT,
        previous_generation BIGINT CHECK(previous_generation IS NULL OR previous_generation > 0),
        next_generation BIGINT NOT NULL CHECK(next_generation > 0),
        previous_owner_kind TEXT CHECK(previous_owner_kind IS NULL OR previous_owner_kind IN ('operator', 'external_companion')),
        next_owner_kind TEXT CHECK(next_owner_kind IS NULL OR next_owner_kind IN ('operator', 'external_companion')),
        previous_lease_state TEXT CHECK(previous_lease_state IS NULL OR previous_lease_state IN (
          'operator_active', 'external_live', 'external_stale', 'released', 'revoked', 'superseded', 'deleted'
        )),
        next_lease_state TEXT NOT NULL CHECK(next_lease_state IN (
          'operator_active', 'external_live', 'external_stale', 'released', 'revoked', 'superseded', 'deleted'
        )),
        reason_code TEXT NOT NULL CHECK(reason_code IN (
          'session_initialized', 'request_created', 'request_rejected', 'request_expired', 'request_cancelled',
          'handoff', 'heartbeat', 'lease_stale', 'reconnect', 'identity_revoked', 'release',
          'operator_revoke', 'emergency_takeover', 'auth_revoked', 'session_deleted',
          'session_reactivated', 'mutation_denied'
        )),
        actor_kind TEXT NOT NULL CHECK(actor_kind IN ('operator', 'external_companion', 'system')),
        actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
        companion_session_id TEXT CHECK(companion_session_id IS NULL OR length(companion_session_id) BETWEEN 1 AND 256),
        device_grant_id TEXT CHECK(device_grant_id IS NULL OR length(device_grant_id) BETWEEN 1 AND 256),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        correlation_id TEXT NOT NULL CHECK(length(correlation_id) BETWEEN 1 AND 256),
        created_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(created_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = created_at
        ),
        FOREIGN KEY(request_id) REFERENCES chat_session_control_requests(request_id) ON DELETE RESTRICT,
        UNIQUE(session_id, event_sequence),
        CHECK(
          (reason_code = 'session_initialized' AND previous_generation IS NULL AND previous_owner_kind IS NULL
            AND previous_lease_state IS NULL AND next_generation = 1 AND next_owner_kind = 'operator'
            AND next_lease_state = 'operator_active' AND actor_kind = 'system')
          OR (reason_code <> 'session_initialized' AND previous_generation IS NOT NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_chat_session_control_events_session_created
        ON chat_session_control_events(session_id, event_sequence);
      CREATE INDEX IF NOT EXISTS idx_chat_session_control_events_workspace_created
        ON chat_session_control_events(workspace_id, created_at DESC, event_id);
      CREATE INDEX IF NOT EXISTS idx_chat_session_control_events_companion_created
        ON chat_session_control_events(companion_session_id, created_at DESC, event_id);
      CREATE INDEX IF NOT EXISTS idx_chat_session_control_events_request_sha256
        ON chat_session_control_events(request_sha256, workspace_id, session_id, event_sequence);

      CREATE TABLE IF NOT EXISTS chat_session_control_auth_revoke_receipts (
        idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        binding_kind TEXT NOT NULL CHECK(binding_kind IN ('companion_session', 'device_grant')),
        binding_id TEXT NOT NULL CHECK(length(binding_id) BETWEEN 1 AND 256),
        actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
        correlation_id TEXT NOT NULL CHECK(length(correlation_id) BETWEEN 1 AND 256),
        target_count BIGINT NOT NULL CHECK(target_count >= 0),
        session_count BIGINT NOT NULL CHECK(session_count >= 0),
        event_set_sha256 TEXT NOT NULL CHECK(event_set_sha256 ~ '^[0-9a-f]{64}$'),
        created_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(created_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = created_at
        ),
        CHECK(
          (target_count = 0 AND session_count = 0
            AND event_set_sha256 = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')
          OR (target_count > 0 AND session_count BETWEEN 1 AND target_count)
        )
      );

      -- Migration 2 builds the current SQLite blueprint on fresh PostgreSQL databases. Its
      -- compatibility translator intentionally omits SQLite CHECK clauses, so the four
      -- production-dark tables can already exist when this forward migration runs. Reconcile
      -- every bounded/enumerated invariant with deterministic names; upgraded databases keep
      -- their inline checks and receive the same named checks harmlessly.
      DO $$
      DECLARE check_spec RECORD;
      BEGIN
        FOR check_spec IN
          SELECT * FROM (VALUES
            ('auth_device_requests', 'gc_adr_principal_purpose', $check$principal_purpose IN ('general_companion', 'session_control_client')$check$),
            ('auth_device_grants', 'gc_adg_principal_purpose', $check$principal_purpose IN ('general_companion', 'session_control_client')$check$),
            ('companion_sessions', 'gc_cs_principal_purpose', $check$principal_purpose IN ('general_companion', 'session_control_client')$check$),

            ('chat_session_control_tokens', 'gc_sct_token_sha256', $check$token_sha256 ~ '^[0-9a-f]{64}$'$check$),
            ('chat_session_control_tokens', 'gc_sct_workspace_length', $check$length(workspace_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_tokens', 'gc_sct_session_length', $check$length(session_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_tokens', 'gc_sct_first_request_length', $check$first_request_id IS NULL OR length(first_request_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_tokens', 'gc_sct_created_at_canonical', $check$gc_try_parse_timestamptz(created_at) IS NOT NULL AND to_char(gc_try_parse_timestamptz(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = created_at$check$),

            ('chat_session_control_requests', 'gc_scr_request_length', $check$length(request_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_requests', 'gc_scr_workspace_length', $check$length(workspace_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_requests', 'gc_scr_session_length', $check$length(session_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_requests', 'gc_scr_companion_length', $check$length(companion_session_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_requests', 'gc_scr_device_length', $check$length(device_grant_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_requests', 'gc_scr_client_length', $check$length(client_instance_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_requests', 'gc_scr_principal_purpose', $check$principal_purpose = 'session_control_client'$check$),
            ('chat_session_control_requests', 'gc_scr_capabilities', $check$requested_capabilities_json IN ('["send"]', '["send","read"]')$check$),
            ('chat_session_control_requests', 'gc_scr_capabilities_sha256', $check$requested_capabilities_sha256 ~ '^[0-9a-f]{64}$'$check$),
            ('chat_session_control_requests', 'gc_scr_capabilities_digest', $check$(requested_capabilities_json = '["send"]' AND requested_capabilities_sha256 = '700f7799ef50095f9d008c356de23c0eb9562ec753f282f2f060079da99c2d2c') OR (requested_capabilities_json = '["send","read"]' AND requested_capabilities_sha256 = 'e58895e823b5a1618273223b24cd04ca99b2f30171b687fade8ef74a27df7a14')$check$),
            ('chat_session_control_requests', 'gc_scr_generation_positive', $check$requested_generation > 0$check$),
            ('chat_session_control_requests', 'gc_scr_status', $check$status IN ('pending', 'rejected', 'expired', 'activated', 'cancelled')$check$),
            ('chat_session_control_requests', 'gc_scr_idempotency_length', $check$length(idempotency_key) BETWEEN 1 AND 512$check$),
            ('chat_session_control_requests', 'gc_scr_request_sha256', $check$request_sha256 ~ '^[0-9a-f]{64}$'$check$),
            ('chat_session_control_requests', 'gc_scr_expires_at_canonical', $check$gc_try_parse_timestamptz(expires_at) IS NOT NULL AND to_char(gc_try_parse_timestamptz(expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = expires_at$check$),
            ('chat_session_control_requests', 'gc_scr_created_at_canonical', $check$gc_try_parse_timestamptz(created_at) IS NOT NULL AND to_char(gc_try_parse_timestamptz(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = created_at$check$),
            ('chat_session_control_requests', 'gc_scr_decided_at_canonical', $check$decided_at IS NULL OR (gc_try_parse_timestamptz(decided_at) IS NOT NULL AND to_char(gc_try_parse_timestamptz(decided_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = decided_at)$check$),
            ('chat_session_control_requests', 'gc_scr_decided_actor_length', $check$decided_by_actor_id IS NULL OR length(decided_by_actor_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_requests', 'gc_scr_decision_reason', $check$decision_reason_code IS NULL OR decision_reason_code IN ('request_rejected', 'request_expired', 'request_cancelled', 'handoff')$check$),
            ('chat_session_control_requests', 'gc_scr_activated_generation', $check$activated_generation IS NULL OR activated_generation > 1$check$),
            ('chat_session_control_requests', 'gc_scr_expiry_after_creation', $check$expires_at > created_at$check$),
            ('chat_session_control_requests', 'gc_scr_lifecycle_shape', $check$(status = 'pending' AND decided_at IS NULL AND decided_by_actor_id IS NULL AND decision_reason_code IS NULL AND activated_generation IS NULL) OR (status = 'activated' AND decided_at IS NOT NULL AND decided_at < expires_at AND decided_by_actor_id IS NOT NULL AND decision_reason_code = 'handoff' AND activated_generation = requested_generation + 1) OR (status = 'rejected' AND decided_at IS NOT NULL AND decided_at < expires_at AND decided_by_actor_id IS NOT NULL AND decision_reason_code = 'request_rejected' AND activated_generation IS NULL) OR (status = 'cancelled' AND decided_at IS NOT NULL AND decided_at < expires_at AND decided_by_actor_id IS NOT NULL AND decision_reason_code = 'request_cancelled' AND activated_generation IS NULL) OR (status = 'expired' AND decided_at IS NOT NULL AND decided_at >= expires_at AND decided_by_actor_id IS NOT NULL AND decision_reason_code = 'request_expired' AND activated_generation IS NULL)$check$),

            ('chat_session_control_grants', 'gc_scg_workspace_length', $check$length(workspace_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_grants', 'gc_scg_session_length', $check$length(session_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_grants', 'gc_scg_generation_positive', $check$generation > 0$check$),
            ('chat_session_control_grants', 'gc_scg_current_flag', $check$is_current IN (0, 1)$check$),
            ('chat_session_control_grants', 'gc_scg_owner_kind', $check$owner_kind IN ('operator', 'external_companion')$check$),
            ('chat_session_control_grants', 'gc_scg_lease_state', $check$lease_state IN ('operator_active', 'external_live', 'external_stale', 'released', 'revoked', 'superseded', 'deleted')$check$),
            ('chat_session_control_grants', 'gc_scg_requested_capabilities', $check$requested_capabilities_json IN ('[]', '["send"]', '["send","read"]')$check$),
            ('chat_session_control_grants', 'gc_scg_requested_sha256', $check$requested_capabilities_sha256 ~ '^[0-9a-f]{64}$'$check$),
            ('chat_session_control_grants', 'gc_scg_requested_digest', $check$(requested_capabilities_json = '[]' AND requested_capabilities_sha256 = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945') OR (requested_capabilities_json = '["send"]' AND requested_capabilities_sha256 = '700f7799ef50095f9d008c356de23c0eb9562ec753f282f2f060079da99c2d2c') OR (requested_capabilities_json = '["send","read"]' AND requested_capabilities_sha256 = 'e58895e823b5a1618273223b24cd04ca99b2f30171b687fade8ef74a27df7a14')$check$),
            ('chat_session_control_grants', 'gc_scg_effective_capabilities', $check$effective_capabilities_json IN ('[]', '["send"]', '["send","read"]')$check$),
            ('chat_session_control_grants', 'gc_scg_effective_sha256', $check$effective_capabilities_sha256 ~ '^[0-9a-f]{64}$'$check$),
            ('chat_session_control_grants', 'gc_scg_effective_digest', $check$(effective_capabilities_json = '[]' AND effective_capabilities_sha256 = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945') OR (effective_capabilities_json = '["send"]' AND effective_capabilities_sha256 = '700f7799ef50095f9d008c356de23c0eb9562ec753f282f2f060079da99c2d2c') OR (effective_capabilities_json = '["send","read"]' AND effective_capabilities_sha256 = 'e58895e823b5a1618273223b24cd04ca99b2f30171b687fade8ef74a27df7a14')$check$),
            ('chat_session_control_grants', 'gc_scg_control_revision', $check$control_revision > 0$check$),
            ('chat_session_control_grants', 'gc_scg_idempotency_length', $check$length(transition_idempotency_key) BETWEEN 1 AND 512$check$),
            ('chat_session_control_grants', 'gc_scg_request_sha256', $check$transition_request_sha256 ~ '^[0-9a-f]{64}$'$check$),
            ('chat_session_control_grants', 'gc_scg_created_at_canonical', $check$gc_try_parse_timestamptz(created_at) IS NOT NULL AND to_char(gc_try_parse_timestamptz(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = created_at$check$),
            ('chat_session_control_grants', 'gc_scg_updated_at_canonical', $check$gc_try_parse_timestamptz(updated_at) IS NOT NULL AND to_char(gc_try_parse_timestamptz(updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = updated_at$check$),
            ('chat_session_control_grants', 'gc_scg_terminal_at_canonical', $check$terminal_at IS NULL OR (gc_try_parse_timestamptz(terminal_at) IS NOT NULL AND to_char(gc_try_parse_timestamptz(terminal_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = terminal_at)$check$),
            ('chat_session_control_grants', 'gc_scg_update_order', $check$updated_at >= created_at$check$),
            ('chat_session_control_grants', 'gc_scg_current_shape', $check$(is_current = 1 AND terminal_at IS NULL AND lease_state IN ('operator_active', 'external_live', 'external_stale')) OR (is_current = 0 AND terminal_at IS NOT NULL AND lease_state IN ('released', 'revoked', 'superseded', 'deleted'))$check$),
            ('chat_session_control_grants', 'gc_scg_owner_shape', $check$(owner_kind = 'operator' AND request_id IS NULL AND companion_session_id IS NULL AND device_grant_id IS NULL AND client_instance_id IS NULL AND principal_purpose IS NULL AND requested_capabilities_json = '[]' AND effective_capabilities_json = '[]' AND token_sha256 IS NULL AND token_expires_at IS NULL AND last_heartbeat_at IS NULL AND lease_expires_at IS NULL AND reconnect_expires_at IS NULL) OR (owner_kind = 'external_companion' AND generation >= 2 AND request_id IS NOT NULL AND length(companion_session_id) BETWEEN 1 AND 256 AND length(device_grant_id) BETWEEN 1 AND 256 AND length(client_instance_id) BETWEEN 1 AND 256 AND principal_purpose = 'session_control_client' AND requested_capabilities_json IN ('["send"]', '["send","read"]') AND effective_capabilities_json IN ('["send"]', '["send","read"]') AND token_sha256 IS NOT NULL AND token_expires_at IS NOT NULL AND last_heartbeat_at IS NOT NULL AND lease_expires_at IS NOT NULL AND reconnect_expires_at IS NOT NULL AND lease_expires_at > last_heartbeat_at AND reconnect_expires_at > lease_expires_at)$check$),

            ('chat_session_control_events', 'gc_sce_event_length', $check$length(event_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_events', 'gc_sce_workspace_length', $check$length(workspace_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_events', 'gc_sce_session_length', $check$length(session_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_events', 'gc_sce_sequence_positive', $check$event_sequence > 0$check$),
            ('chat_session_control_events', 'gc_sce_previous_generation', $check$previous_generation IS NULL OR previous_generation > 0$check$),
            ('chat_session_control_events', 'gc_sce_next_generation', $check$next_generation > 0$check$),
            ('chat_session_control_events', 'gc_sce_previous_owner', $check$previous_owner_kind IS NULL OR previous_owner_kind IN ('operator', 'external_companion')$check$),
            ('chat_session_control_events', 'gc_sce_next_owner', $check$next_owner_kind IS NULL OR next_owner_kind IN ('operator', 'external_companion')$check$),
            ('chat_session_control_events', 'gc_sce_previous_lease', $check$previous_lease_state IS NULL OR previous_lease_state IN ('operator_active', 'external_live', 'external_stale', 'released', 'revoked', 'superseded', 'deleted')$check$),
            ('chat_session_control_events', 'gc_sce_next_lease', $check$next_lease_state IN ('operator_active', 'external_live', 'external_stale', 'released', 'revoked', 'superseded', 'deleted')$check$),
            ('chat_session_control_events', 'gc_sce_reason_code', $check$reason_code IN ('session_initialized', 'request_created', 'request_rejected', 'request_expired', 'request_cancelled', 'handoff', 'heartbeat', 'lease_stale', 'reconnect', 'identity_revoked', 'release', 'operator_revoke', 'emergency_takeover', 'auth_revoked', 'session_deleted', 'session_reactivated', 'mutation_denied')$check$),
            ('chat_session_control_events', 'gc_sce_actor_kind', $check$actor_kind IN ('operator', 'external_companion', 'system')$check$),
            ('chat_session_control_events', 'gc_sce_actor_length', $check$length(actor_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_events', 'gc_sce_companion_length', $check$companion_session_id IS NULL OR length(companion_session_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_events', 'gc_sce_device_length', $check$device_grant_id IS NULL OR length(device_grant_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_events', 'gc_sce_idempotency_length', $check$length(idempotency_key) BETWEEN 1 AND 512$check$),
            ('chat_session_control_events', 'gc_sce_request_sha256', $check$request_sha256 ~ '^[0-9a-f]{64}$'$check$),
            ('chat_session_control_events', 'gc_sce_correlation_length', $check$length(correlation_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_events', 'gc_sce_created_at_canonical', $check$gc_try_parse_timestamptz(created_at) IS NOT NULL AND to_char(gc_try_parse_timestamptz(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = created_at$check$),
            ('chat_session_control_events', 'gc_sce_initialization_shape', $check$(reason_code = 'session_initialized' AND previous_generation IS NULL AND previous_owner_kind IS NULL AND previous_lease_state IS NULL AND next_generation = 1 AND next_owner_kind = 'operator' AND next_lease_state = 'operator_active' AND actor_kind = 'system') OR (reason_code <> 'session_initialized' AND previous_generation IS NOT NULL)$check$),

            ('chat_session_control_auth_revoke_receipts', 'gc_scarr_idempotency_length', $check$length(idempotency_key) BETWEEN 1 AND 512$check$),
            ('chat_session_control_auth_revoke_receipts', 'gc_scarr_request_sha256', $check$request_sha256 ~ '^[0-9a-f]{64}$'$check$),
            ('chat_session_control_auth_revoke_receipts', 'gc_scarr_binding_kind', $check$binding_kind IN ('companion_session', 'device_grant')$check$),
            ('chat_session_control_auth_revoke_receipts', 'gc_scarr_binding_length', $check$length(binding_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_auth_revoke_receipts', 'gc_scarr_actor_length', $check$length(actor_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_auth_revoke_receipts', 'gc_scarr_correlation_length', $check$length(correlation_id) BETWEEN 1 AND 256$check$),
            ('chat_session_control_auth_revoke_receipts', 'gc_scarr_target_nonnegative', $check$target_count >= 0$check$),
            ('chat_session_control_auth_revoke_receipts', 'gc_scarr_session_shape', $check$(target_count = 0 AND session_count = 0 AND event_set_sha256 = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945') OR (target_count > 0 AND session_count BETWEEN 1 AND target_count)$check$),
            ('chat_session_control_auth_revoke_receipts', 'gc_scarr_event_set_sha256', $check$event_set_sha256 ~ '^[0-9a-f]{64}$'$check$),
            ('chat_session_control_auth_revoke_receipts', 'gc_scarr_created_at_canonical', $check$gc_try_parse_timestamptz(created_at) IS NOT NULL AND to_char(gc_try_parse_timestamptz(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = created_at$check$)
          ) AS checks(table_name, constraint_name, check_expression)
        LOOP
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass(check_spec.table_name)
              AND constraint_row.conname = check_spec.constraint_name
          ) THEN
            EXECUTE format(
              'ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s)',
              check_spec.table_name,
              check_spec.constraint_name,
              check_spec.check_expression
            );
          END IF;
        END LOOP;
      END;
      $$;

      CREATE OR REPLACE FUNCTION gc_auth_device_request_principal_purpose_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.principal_purpose IS DISTINCT FROM OLD.principal_purpose THEN
          RAISE EXCEPTION 'auth device request principal purpose is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_auth_device_requests_principal_purpose_immutable
        BEFORE UPDATE ON auth_device_requests FOR EACH ROW
        EXECUTE FUNCTION gc_auth_device_request_principal_purpose_guard();

      CREATE OR REPLACE FUNCTION gc_auth_device_grant_principal_purpose_guard()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'UPDATE' AND (
          NEW.request_id IS DISTINCT FROM OLD.request_id
          OR NEW.principal_purpose IS DISTINCT FROM OLD.principal_purpose
        ) THEN
          RAISE EXCEPTION 'auth device grant parent and principal purpose are immutable' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM auth_device_requests request_row
          WHERE request_row.request_id = NEW.request_id
            AND request_row.principal_purpose = NEW.principal_purpose
        ) THEN
          RAISE EXCEPTION 'auth device grant principal purpose must match its request' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_auth_device_grants_principal_purpose_guard
        BEFORE INSERT OR UPDATE ON auth_device_grants FOR EACH ROW
        EXECUTE FUNCTION gc_auth_device_grant_principal_purpose_guard();

      CREATE OR REPLACE FUNCTION gc_companion_session_principal_purpose_guard()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'UPDATE' AND (
          NEW.grant_id IS DISTINCT FROM OLD.grant_id
          OR NEW.principal_purpose IS DISTINCT FROM OLD.principal_purpose
        ) THEN
          RAISE EXCEPTION 'companion session parent and principal purpose are immutable' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM auth_device_grants grant_row
          WHERE grant_row.grant_id = NEW.grant_id
            AND grant_row.principal_purpose = NEW.principal_purpose
        ) THEN
          RAISE EXCEPTION 'companion session principal purpose must match its grant' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_companion_sessions_principal_purpose_guard
        BEFORE INSERT OR UPDATE ON companion_sessions FOR EACH ROW
        EXECUTE FUNCTION gc_companion_session_principal_purpose_guard();

      CREATE OR REPLACE FUNCTION gc_session_control_token_insert_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM chat_session_control_grants grant_row
          WHERE grant_row.workspace_id = NEW.workspace_id AND grant_row.session_id = NEW.session_id
        ) THEN
          RAISE EXCEPTION 'session control token binding invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_session_control_tokens_insert_guard
        BEFORE INSERT ON chat_session_control_tokens FOR EACH ROW EXECUTE FUNCTION gc_session_control_token_insert_guard();

      CREATE OR REPLACE FUNCTION gc_session_control_request_insert_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.status <> 'pending'
          OR NOT EXISTS (
            SELECT 1 FROM chat_session_control_tokens token_row
            WHERE token_row.token_sha256 = NEW.token_sha256
              AND token_row.workspace_id = NEW.workspace_id
              AND token_row.session_id = NEW.session_id
              AND token_row.first_request_id = NEW.request_id
          )
          OR NOT EXISTS (
            SELECT 1 FROM chat_session_control_grants grant_row
            WHERE grant_row.workspace_id = NEW.workspace_id AND grant_row.session_id = NEW.session_id
              AND grant_row.generation = NEW.requested_generation AND grant_row.is_current = 1
              AND grant_row.owner_kind = 'operator' AND grant_row.lease_state = 'operator_active'
          )
          OR NOT EXISTS (
            SELECT 1
            FROM companion_sessions companion_session
            JOIN auth_device_grants device_grant ON device_grant.grant_id = companion_session.grant_id
            JOIN auth_device_requests device_request ON device_request.request_id = device_grant.request_id
            WHERE companion_session.session_id = NEW.companion_session_id
              AND companion_session.grant_id = NEW.device_grant_id
              AND companion_session.principal_purpose = NEW.principal_purpose
              AND device_grant.principal_purpose = NEW.principal_purpose
              AND device_request.principal_purpose = NEW.principal_purpose
              AND NEW.principal_purpose = 'session_control_client'
              AND companion_session.revoked_at IS NULL AND device_grant.revoked_at IS NULL
              AND gc_try_parse_timestamptz(companion_session.refresh_token_expires_at) > clock_timestamp()
              AND (device_grant.expires_at IS NULL
                OR gc_try_parse_timestamptz(device_grant.expires_at) > clock_timestamp())
          ) THEN
          RAISE EXCEPTION 'session control request binding invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_session_control_requests_insert_guard
        BEFORE INSERT ON chat_session_control_requests FOR EACH ROW EXECUTE FUNCTION gc_session_control_request_insert_guard();

      CREATE OR REPLACE FUNCTION gc_reject_session_control_immutable_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'session control record is immutable' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_session_control_tokens_no_update
        BEFORE UPDATE ON chat_session_control_tokens FOR EACH ROW EXECUTE FUNCTION gc_reject_session_control_immutable_mutation();
      CREATE TRIGGER trg_chat_session_control_tokens_no_delete
        BEFORE DELETE ON chat_session_control_tokens FOR EACH ROW EXECUTE FUNCTION gc_reject_session_control_immutable_mutation();
      CREATE TRIGGER trg_chat_session_control_requests_no_delete
        BEFORE DELETE ON chat_session_control_requests FOR EACH ROW EXECUTE FUNCTION gc_reject_session_control_immutable_mutation();
      CREATE TRIGGER trg_chat_session_control_grants_no_delete
        BEFORE DELETE ON chat_session_control_grants FOR EACH ROW EXECUTE FUNCTION gc_reject_session_control_immutable_mutation();
      CREATE TRIGGER trg_chat_session_control_events_no_update
        BEFORE UPDATE ON chat_session_control_events FOR EACH ROW EXECUTE FUNCTION gc_reject_session_control_immutable_mutation();
      CREATE TRIGGER trg_chat_session_control_events_no_delete
        BEFORE DELETE ON chat_session_control_events FOR EACH ROW EXECUTE FUNCTION gc_reject_session_control_immutable_mutation();
      CREATE TRIGGER trg_chat_session_control_auth_revoke_receipts_no_update
        BEFORE UPDATE ON chat_session_control_auth_revoke_receipts FOR EACH ROW
        EXECUTE FUNCTION gc_reject_session_control_immutable_mutation();
      CREATE TRIGGER trg_chat_session_control_auth_revoke_receipts_no_delete
        BEFORE DELETE ON chat_session_control_auth_revoke_receipts FOR EACH ROW
        EXECUTE FUNCTION gc_reject_session_control_immutable_mutation();

      CREATE OR REPLACE FUNCTION gc_session_control_request_transition_guard()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.status <> 'pending'
          OR NEW.request_id <> OLD.request_id OR NEW.workspace_id <> OLD.workspace_id
          OR NEW.session_id <> OLD.session_id OR NEW.companion_session_id <> OLD.companion_session_id
          OR NEW.device_grant_id <> OLD.device_grant_id OR NEW.client_instance_id <> OLD.client_instance_id
          OR NEW.principal_purpose <> OLD.principal_purpose OR NEW.token_sha256 <> OLD.token_sha256
          OR NEW.requested_capabilities_json <> OLD.requested_capabilities_json
          OR NEW.requested_capabilities_sha256 <> OLD.requested_capabilities_sha256
          OR NEW.requested_generation <> OLD.requested_generation OR NEW.idempotency_key <> OLD.idempotency_key
          OR NEW.request_sha256 <> OLD.request_sha256 OR NEW.expires_at <> OLD.expires_at
          OR NEW.created_at <> OLD.created_at OR NEW.status = 'pending'
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.decided_at) - clock_timestamp()))) > 1 THEN
          RAISE EXCEPTION 'session control request transition invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_session_control_requests_transition_guard
        BEFORE UPDATE ON chat_session_control_requests FOR EACH ROW EXECUTE FUNCTION gc_session_control_request_transition_guard();

      CREATE OR REPLACE FUNCTION gc_session_control_grant_insert_guard()
      RETURNS trigger AS $$
      DECLARE prior_generation BIGINT;
      DECLARE prior_workspace TEXT;
      DECLARE database_now TIMESTAMPTZ := clock_timestamp();
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.session_id, 411));
        SELECT MAX(generation), MIN(workspace_id) INTO prior_generation, prior_workspace
        FROM chat_session_control_grants WHERE session_id = NEW.session_id;
        IF NEW.is_current <> 1
          OR (prior_workspace IS NOT NULL AND prior_workspace <> NEW.workspace_id)
          OR (prior_generation IS NULL AND NEW.generation <> 1)
          OR (prior_generation IS NOT NULL AND NEW.generation <> prior_generation + 1)
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.created_at) - database_now))) > 1
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.updated_at) - database_now))) > 1 THEN
          RAISE EXCEPTION 'session control generation, workspace, or database-clock invariant violated' USING ERRCODE = '23514';
        END IF;
        IF NEW.owner_kind = 'external_companion' AND NOT EXISTS (
          SELECT 1
          FROM chat_session_control_requests request_row
          JOIN chat_session_control_tokens token_row ON token_row.token_sha256 = NEW.token_sha256
          WHERE request_row.request_id = NEW.request_id
            AND request_row.workspace_id = NEW.workspace_id AND request_row.session_id = NEW.session_id
            AND request_row.companion_session_id = NEW.companion_session_id
            AND request_row.device_grant_id = NEW.device_grant_id
            AND request_row.client_instance_id = NEW.client_instance_id
            AND request_row.principal_purpose = NEW.principal_purpose
            AND request_row.requested_capabilities_json = NEW.requested_capabilities_json
            AND request_row.requested_capabilities_sha256 = NEW.requested_capabilities_sha256
            AND request_row.status = 'activated' AND request_row.decision_reason_code = 'handoff'
            AND request_row.activated_generation = request_row.requested_generation + 1
            AND request_row.activated_generation <= NEW.generation
            AND token_row.workspace_id = NEW.workspace_id AND token_row.session_id = NEW.session_id
            AND (
              (NEW.generation = request_row.activated_generation AND NEW.token_sha256 = request_row.token_sha256)
              OR (NEW.generation > request_row.activated_generation AND EXISTS (
                SELECT 1 FROM chat_session_control_grants prior
                WHERE prior.workspace_id = NEW.workspace_id AND prior.session_id = NEW.session_id
                  AND prior.generation = NEW.generation - 1 AND prior.owner_kind = 'external_companion'
                  AND prior.request_id = NEW.request_id
                  AND prior.companion_session_id = NEW.companion_session_id
                  AND prior.device_grant_id = NEW.device_grant_id
                  AND prior.client_instance_id = NEW.client_instance_id
                  AND prior.principal_purpose = NEW.principal_purpose
                  AND prior.requested_capabilities_json = NEW.requested_capabilities_json
                  AND prior.requested_capabilities_sha256 = NEW.requested_capabilities_sha256
                  AND prior.effective_capabilities_json = NEW.effective_capabilities_json
                  AND prior.effective_capabilities_sha256 = NEW.effective_capabilities_sha256
              ))
            )
            AND (
              (NEW.requested_capabilities_json = '["send"]' AND NEW.effective_capabilities_json = '["send"]')
              OR (NEW.requested_capabilities_json = '["send","read"]'
                AND NEW.effective_capabilities_json IN ('["send"]', '["send","read"]'))
            )
        ) THEN
          RAISE EXCEPTION 'session control external request binding invariant violated' USING ERRCODE = '23514';
        END IF;
        IF NEW.owner_kind = 'external_companion' AND NOT EXISTS (
          SELECT 1
          FROM companion_sessions companion_session
          JOIN auth_device_grants device_grant ON device_grant.grant_id = companion_session.grant_id
          JOIN auth_device_requests device_request ON device_request.request_id = device_grant.request_id
          WHERE companion_session.session_id = NEW.companion_session_id
            AND companion_session.grant_id = NEW.device_grant_id
            AND companion_session.principal_purpose = NEW.principal_purpose
            AND device_grant.principal_purpose = NEW.principal_purpose
            AND device_request.principal_purpose = NEW.principal_purpose
            AND NEW.principal_purpose = 'session_control_client'
            AND companion_session.revoked_at IS NULL AND device_grant.revoked_at IS NULL
            AND gc_try_parse_timestamptz(companion_session.refresh_token_expires_at) > database_now
            AND (device_grant.expires_at IS NULL
              OR gc_try_parse_timestamptz(device_grant.expires_at) > database_now)
        ) THEN
          RAISE EXCEPTION 'session control external auth binding invariant violated' USING ERRCODE = '23514';
        END IF;
        IF NEW.owner_kind = 'external_companion' AND (
          abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.token_expires_at) - database_now)) - 900) > 1
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.lease_expires_at) - database_now)) - 60) > 1
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.reconnect_expires_at) - database_now)) - 300) > 1
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.last_heartbeat_at) - database_now))) > 1
        ) THEN
          RAISE EXCEPTION 'session control external database-clock invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_session_control_grants_insert_guard
        BEFORE INSERT ON chat_session_control_grants FOR EACH ROW EXECUTE FUNCTION gc_session_control_grant_insert_guard();

      CREATE OR REPLACE FUNCTION gc_session_control_grant_update_guard()
      RETURNS trigger AS $$
      DECLARE database_now TIMESTAMPTZ := clock_timestamp();
      DECLARE valid_transition BOOLEAN := FALSE;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.session_id, 411));
        IF OLD.is_current <> 1 OR OLD.terminal_at IS NOT NULL
          OR NEW.workspace_id <> OLD.workspace_id OR NEW.session_id <> OLD.session_id
          OR NEW.generation <> OLD.generation OR NEW.owner_kind <> OLD.owner_kind
          OR NEW.request_id IS DISTINCT FROM OLD.request_id
          OR NEW.companion_session_id IS DISTINCT FROM OLD.companion_session_id
          OR NEW.device_grant_id IS DISTINCT FROM OLD.device_grant_id
          OR NEW.client_instance_id IS DISTINCT FROM OLD.client_instance_id
          OR NEW.principal_purpose IS DISTINCT FROM OLD.principal_purpose
          OR NEW.requested_capabilities_json <> OLD.requested_capabilities_json
          OR NEW.requested_capabilities_sha256 <> OLD.requested_capabilities_sha256
          OR NEW.effective_capabilities_json <> OLD.effective_capabilities_json
          OR NEW.effective_capabilities_sha256 <> OLD.effective_capabilities_sha256
          OR NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256
          OR NEW.token_expires_at IS DISTINCT FROM OLD.token_expires_at
          OR NEW.transition_idempotency_key <> OLD.transition_idempotency_key
          OR NEW.transition_request_sha256 <> OLD.transition_request_sha256
          OR NEW.created_at <> OLD.created_at OR NEW.control_revision <> OLD.control_revision + 1
          OR NEW.updated_at < OLD.updated_at
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.updated_at) - database_now))) > 1 THEN
          RAISE EXCEPTION 'session control current generation transition invariant violated' USING ERRCODE = '23514';
        END IF;
        valid_transition := OLD.owner_kind = 'external_companion' AND OLD.lease_state = 'external_live'
          AND NEW.is_current = 1 AND NEW.lease_state = 'external_live' AND NEW.terminal_at IS NULL
          AND gc_try_parse_timestamptz(NEW.last_heartbeat_at) >= gc_try_parse_timestamptz(OLD.last_heartbeat_at)
          AND abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.last_heartbeat_at) - database_now))) <= 1
          AND abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.lease_expires_at) - database_now)) - 60) <= 1
          AND abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.reconnect_expires_at) - database_now)) - 300) <= 1;
        valid_transition := valid_transition OR (
          OLD.owner_kind = 'external_companion' AND OLD.lease_state = 'external_live'
          AND NEW.is_current = 1 AND NEW.lease_state = 'external_stale' AND NEW.terminal_at IS NULL
          AND NEW.last_heartbeat_at = OLD.last_heartbeat_at AND NEW.lease_expires_at = OLD.lease_expires_at
          AND NEW.reconnect_expires_at = OLD.reconnect_expires_at
        );
        valid_transition := valid_transition OR (
          NEW.is_current = 0 AND NEW.lease_state IN ('released', 'revoked', 'superseded', 'deleted')
          AND NEW.terminal_at = NEW.updated_at
          AND NEW.last_heartbeat_at IS NOT DISTINCT FROM OLD.last_heartbeat_at
          AND NEW.lease_expires_at IS NOT DISTINCT FROM OLD.lease_expires_at
          AND NEW.reconnect_expires_at IS NOT DISTINCT FROM OLD.reconnect_expires_at
        );
        IF NOT valid_transition THEN
          RAISE EXCEPTION 'session control current generation transition invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_session_control_grants_update_guard
        BEFORE UPDATE ON chat_session_control_grants FOR EACH ROW EXECUTE FUNCTION gc_session_control_grant_update_guard();

      CREATE OR REPLACE FUNCTION gc_session_control_event_insert_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.request_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM chat_session_control_requests request_row
          WHERE request_row.request_id = NEW.request_id
            AND request_row.workspace_id = NEW.workspace_id AND request_row.session_id = NEW.session_id
            AND request_row.companion_session_id = NEW.companion_session_id
            AND request_row.device_grant_id = NEW.device_grant_id
        ) THEN
          RAISE EXCEPTION 'session control event request attribution invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_session_control_events_insert_guard
        BEFORE INSERT ON chat_session_control_events FOR EACH ROW EXECUTE FUNCTION gc_session_control_event_insert_guard();

      CREATE OR REPLACE FUNCTION gc_session_control_auth_revoke_receipt_insert_guard()
      RETURNS trigger AS $$
      DECLARE event_count BIGINT;
      DECLARE distinct_session_count BIGINT;
      BEGIN
        SELECT COUNT(*), COUNT(DISTINCT (event_row.workspace_id, event_row.session_id))
        INTO event_count, distinct_session_count
        FROM chat_session_control_events event_row
        WHERE event_row.request_sha256 = NEW.request_sha256;
        IF abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.created_at) - clock_timestamp()))) > 1
          OR event_count <> NEW.target_count
          OR distinct_session_count <> NEW.session_count
          OR (NEW.target_count > 0 AND NOT EXISTS (
            SELECT 1 FROM chat_session_control_events event_row
            WHERE event_row.request_sha256 = NEW.request_sha256
              AND event_row.idempotency_key = NEW.idempotency_key
          )) THEN
          RAISE EXCEPTION 'session control auth revoke receipt invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_session_control_auth_revoke_receipts_insert_guard
        BEFORE INSERT ON chat_session_control_auth_revoke_receipts FOR EACH ROW
        EXECUTE FUNCTION gc_session_control_auth_revoke_receipt_insert_guard();

      INSERT INTO chat_session_control_grants (
        workspace_id, session_id, generation, is_current, owner_kind, lease_state,
        requested_capabilities_json, requested_capabilities_sha256,
        effective_capabilities_json, effective_capabilities_sha256,
        control_revision, transition_idempotency_key, transition_request_sha256,
        created_at, updated_at
      )
      SELECT
        meta.workspace_id, meta.session_id, 1, 1, 'operator', 'operator_active',
        '[]', '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        '[]', '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        1, 'migration:114:' || meta.session_id,
        '2611e731bb3250febc517d518b578ae6a30102dc92f0d07d9efdd14e4ae4a26c',
        to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      FROM chat_session_meta meta
      WHERE NOT EXISTS (
        SELECT 1 FROM chat_session_control_grants grant_row WHERE grant_row.session_id = meta.session_id
      );

      INSERT INTO chat_session_control_events (
        event_id, workspace_id, session_id, event_sequence, request_id, previous_generation, next_generation,
        previous_owner_kind, next_owner_kind, previous_lease_state, next_lease_state,
        reason_code, actor_kind, actor_id, companion_session_id, device_grant_id,
        idempotency_key, request_sha256, correlation_id, created_at
      )
      SELECT
        'sce_' || md5(meta.session_id || ':114') || substr(md5('114:' || meta.session_id), 1, 16),
        meta.workspace_id, meta.session_id, 1, NULL, NULL, 1, NULL, 'operator', NULL, 'operator_active',
        'session_initialized', 'system', 'system', NULL, NULL,
        'migration:114:event:' || meta.session_id,
        '2611e731bb3250febc517d518b578ae6a30102dc92f0d07d9efdd14e4ae4a26c',
        'migration:114',
        to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      FROM chat_session_meta meta
      JOIN chat_session_control_grants grant_row
        ON grant_row.session_id = meta.session_id AND grant_row.generation = 1
      WHERE NOT EXISTS (
        SELECT 1 FROM chat_session_control_events event_row WHERE event_row.session_id = meta.session_id
      );

      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM chat_session_meta meta
          LEFT JOIN chat_session_control_grants grant_row
            ON grant_row.session_id = meta.session_id AND grant_row.is_current = 1
          WHERE grant_row.session_id IS NULL OR grant_row.workspace_id <> meta.workspace_id
            OR NOT EXISTS (
              SELECT 1 FROM chat_session_control_events event_row WHERE event_row.session_id = meta.session_id
            )
        ) THEN
          RAISE EXCEPTION 'session control backfill invariant violated' USING ERRCODE = '23514';
        END IF;
      END;
      $$;
    `,
  },
  {
    version: 115,
    name: "session_control_lifecycle_and_mutation_admission",
    sql: `
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM chat_session_meta meta
          LEFT JOIN chat_session_control_grants control
            ON control.session_id = meta.session_id AND control.is_current = 1
          WHERE control.session_id IS NULL OR control.workspace_id <> meta.workspace_id
        ) OR EXISTS (
          SELECT 1
          FROM chat_session_control_grants control
          LEFT JOIN chat_session_meta meta ON meta.session_id = control.session_id
          WHERE control.is_current = 1
            AND (meta.session_id IS NULL OR meta.workspace_id <> control.workspace_id)
        ) OR EXISTS (
          SELECT session_id FROM chat_session_control_grants WHERE is_current = 1
          GROUP BY session_id HAVING COUNT(*) <> 1
        ) THEN
          RAISE EXCEPTION 'session control lifecycle preflight invariant violated' USING ERRCODE = '23514';
        END IF;
      END;
      $$;

      ALTER TABLE chat_session_meta ADD COLUMN IF NOT EXISTS lifecycle_intent_id TEXT;
      ALTER TABLE chat_session_meta ADD COLUMN IF NOT EXISTS deletion_intent_id TEXT;

      CREATE TABLE IF NOT EXISTS chat_session_control_auth_revoke_operations (
        idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        binding_kind TEXT NOT NULL CHECK(binding_kind IN ('companion_session', 'device_grant')),
        binding_id TEXT NOT NULL CHECK(length(binding_id) BETWEEN 1 AND 256),
        actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
        correlation_id TEXT NOT NULL CHECK(length(correlation_id) BETWEEN 1 AND 256),
        target_count BIGINT NOT NULL CHECK(target_count >= 0),
        session_count BIGINT NOT NULL CHECK(session_count >= 0),
        event_set_sha256 TEXT NOT NULL CHECK(event_set_sha256 ~ '^[0-9a-f]{64}$'),
        occurred_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(occurred_at) IS NOT NULL),
        CONSTRAINT fk_chat_session_control_auth_revoke_operation_receipt
          FOREIGN KEY(idempotency_key) REFERENCES chat_session_control_auth_revoke_receipts(idempotency_key)
          DEFERRABLE INITIALLY DEFERRED,
        CHECK((target_count = 0 AND session_count = 0
          AND event_set_sha256 = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')
          OR (target_count > 0 AND session_count BETWEEN 1 AND target_count))
      );

      ALTER TABLE chat_session_control_auth_revoke_operations
        DROP CONSTRAINT IF EXISTS chat_session_control_auth_revoke_operation_idempotency_key_fkey;
      ALTER TABLE chat_session_control_auth_revoke_operations
        DROP CONSTRAINT IF EXISTS fk_chat_session_control_auth_revoke_operation_receipt;
      ALTER TABLE chat_session_control_auth_revoke_operations
        ADD CONSTRAINT fk_chat_session_control_auth_revoke_operation_receipt
        FOREIGN KEY(idempotency_key) REFERENCES chat_session_control_auth_revoke_receipts(idempotency_key)
        DEFERRABLE INITIALLY DEFERRED;

      CREATE TABLE IF NOT EXISTS chat_session_control_auth_revoke_operation_targets (
        operation_idempotency_key TEXT NOT NULL,
        target_index BIGINT NOT NULL CHECK(target_index >= 0),
        target_kind TEXT NOT NULL CHECK(target_kind IN ('pending_request', 'current_grant')),
        workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
        session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
        request_id TEXT,
        generation BIGINT NOT NULL CHECK(generation > 0),
        control_revision BIGINT NOT NULL CHECK(control_revision > 0),
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('operator', 'external_companion')),
        lease_state TEXT NOT NULL CHECK(lease_state IN ('operator_active', 'external_live', 'external_stale')),
        event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) BETWEEN 1 AND 256),
        event_sequence BIGINT NOT NULL CHECK(event_sequence > 0),
        event_idempotency_key TEXT NOT NULL UNIQUE CHECK(length(event_idempotency_key) BETWEEN 1 AND 512),
        event_reason_code TEXT NOT NULL CHECK(event_reason_code IN ('auth_revoked', 'mutation_denied', 'request_expired')),
        PRIMARY KEY(operation_idempotency_key, target_index),
        UNIQUE(operation_idempotency_key, target_kind, session_id, request_id, generation),
        FOREIGN KEY(operation_idempotency_key)
          REFERENCES chat_session_control_auth_revoke_operations(idempotency_key) ON DELETE RESTRICT,
        CHECK((target_kind = 'pending_request' AND request_id IS NOT NULL)
          OR (target_kind = 'current_grant' AND owner_kind = 'external_companion'))
      );
      CREATE INDEX IF NOT EXISTS idx_chat_session_control_auth_revoke_targets_session
        ON chat_session_control_auth_revoke_operation_targets(operation_idempotency_key, session_id, target_index);

      CREATE TABLE IF NOT EXISTS chat_session_lifecycle_intents (
        intent_id TEXT PRIMARY KEY CHECK(length(intent_id) BETWEEN 1 AND 256),
        session_incarnation_id TEXT NOT NULL CHECK(length(session_incarnation_id) BETWEEN 1 AND 320),
        workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
        session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
        intent_kind TEXT NOT NULL CHECK(intent_kind IN ('initialize', 'reactivate', 'delete')),
        expected_generation BIGINT CHECK(expected_generation IS NULL OR expected_generation > 0),
        next_generation BIGINT NOT NULL CHECK(next_generation > 0),
        expected_revision BIGINT CHECK(expected_revision IS NULL OR expected_revision > 0),
        actor_kind TEXT NOT NULL CHECK(actor_kind IN ('operator', 'system')),
        actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        correlation_id TEXT NOT NULL CHECK(length(correlation_id) BETWEEN 1 AND 256),
        event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) BETWEEN 1 AND 256),
        created_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(created_at) IS NOT NULL),
        UNIQUE(workspace_id, session_id, intent_kind, next_generation),
        CHECK((intent_kind = 'initialize' AND expected_generation IS NULL AND next_generation = 1
            AND expected_revision IS NULL AND actor_kind = 'system')
          OR (intent_kind = 'reactivate' AND expected_generation IS NOT NULL
            AND next_generation = expected_generation + 1 AND expected_revision IS NULL)
          OR (intent_kind = 'delete' AND expected_generation IS NOT NULL
            AND next_generation = expected_generation AND expected_revision IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_chat_session_lifecycle_intents_session
        ON chat_session_lifecycle_intents(session_id, next_generation, intent_kind);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_session_meta_lifecycle_intent
        ON chat_session_meta(lifecycle_intent_id) WHERE lifecycle_intent_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_session_meta_deletion_intent
        ON chat_session_meta(deletion_intent_id) WHERE deletion_intent_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS chat_session_mutation_admissions (
        admission_id TEXT PRIMARY KEY CHECK(length(admission_id) BETWEEN 1 AND 256),
        session_incarnation_id TEXT NOT NULL CHECK(length(session_incarnation_id) BETWEEN 1 AND 320),
        workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
        session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
        turn_id TEXT UNIQUE CHECK(turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 256),
        runtime_owner_id TEXT CHECK(runtime_owner_id IS NULL OR length(runtime_owner_id) BETWEEN 1 AND 256),
        runtime_last_heartbeat_at TEXT CHECK(
          runtime_last_heartbeat_at IS NULL OR gc_try_parse_timestamptz(runtime_last_heartbeat_at) IS NOT NULL
        ),
        runtime_lease_expires_at TEXT CHECK(
          runtime_lease_expires_at IS NULL OR gc_try_parse_timestamptz(runtime_lease_expires_at) IS NOT NULL
        ),
        runtime_lease_revision BIGINT CHECK(runtime_lease_revision IS NULL OR runtime_lease_revision > 0),
        runtime_lease_relinquished_at TEXT CHECK(
          runtime_lease_relinquished_at IS NULL OR gc_try_parse_timestamptz(runtime_lease_relinquished_at) IS NOT NULL
        ),
        admission_kind TEXT NOT NULL CHECK(admission_kind IN ('synchronous', 'turn_write')),
        aggregate_revision BIGINT NOT NULL CHECK(aggregate_revision > 0),
        controller_generation BIGINT NOT NULL CHECK(controller_generation > 0),
        actor_kind TEXT NOT NULL CHECK(actor_kind IN ('operator', 'external_companion', 'system')),
        actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
        operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
        material_sha256 TEXT NOT NULL CHECK(material_sha256 ~ '^[0-9a-f]{64}$'),
        status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'cancelled')),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        correlation_id TEXT NOT NULL CHECK(length(correlation_id) BETWEEN 1 AND 256),
        admit_event_id TEXT NOT NULL UNIQUE CHECK(length(admit_event_id) BETWEEN 1 AND 256),
        created_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(created_at) IS NOT NULL),
        closed_at TEXT CHECK(closed_at IS NULL OR gc_try_parse_timestamptz(closed_at) IS NOT NULL),
        terminal_actor_id TEXT,
        terminal_event_id TEXT UNIQUE,
        terminal_idempotency_key TEXT UNIQUE,
        terminal_correlation_id TEXT,
        terminal_authority_kind TEXT CHECK(terminal_authority_kind IS NULL OR terminal_authority_kind IN (
          'synchronous', 'request_runtime', 'durable_run', 'durable_terminal', 'expired_recovery',
          'lifecycle_delete', 'authority_superseded', 'post_commit_child_stage'
        )),
        terminal_runtime_owner_id TEXT CHECK(
          terminal_runtime_owner_id IS NULL OR length(terminal_runtime_owner_id) BETWEEN 1 AND 256
        ),
        terminal_runtime_lease_revision BIGINT CHECK(
          terminal_runtime_lease_revision IS NULL OR terminal_runtime_lease_revision > 0
        ),
        terminal_durable_run_id TEXT CHECK(
          terminal_durable_run_id IS NULL OR length(terminal_durable_run_id) BETWEEN 1 AND 256
        ),
        terminal_durable_lease_owner_id TEXT CHECK(
          terminal_durable_lease_owner_id IS NULL OR length(terminal_durable_lease_owner_id) BETWEEN 1 AND 256
        ),
        terminal_durable_attempt_count BIGINT CHECK(
          terminal_durable_attempt_count IS NULL OR terminal_durable_attempt_count >= 0
        ),
        terminal_durable_run_version BIGINT CHECK(
          terminal_durable_run_version IS NULL OR terminal_durable_run_version > 0
        ),
        terminal_durable_run_status TEXT CHECK(
          terminal_durable_run_status IS NULL OR terminal_durable_run_status IN (
            'running', 'completed', 'failed', 'cancelled', 'dead_lettered'
          )
        ),
        terminal_lifecycle_intent_id TEXT CHECK(
          terminal_lifecycle_intent_id IS NULL OR length(terminal_lifecycle_intent_id) BETWEEN 1 AND 256
        ),
        terminal_control_event_id TEXT CHECK(
          terminal_control_event_id IS NULL OR length(terminal_control_event_id) BETWEEN 1 AND 256
        ),
        CHECK((status = 'active' AND closed_at IS NULL AND terminal_actor_id IS NULL
            AND terminal_event_id IS NULL AND terminal_idempotency_key IS NULL AND terminal_correlation_id IS NULL)
          OR (status IN ('completed', 'cancelled') AND closed_at IS NOT NULL
            AND length(terminal_actor_id) BETWEEN 1 AND 256 AND length(terminal_event_id) BETWEEN 1 AND 256
            AND length(terminal_idempotency_key) BETWEEN 1 AND 512
            AND length(terminal_correlation_id) BETWEEN 1 AND 256)),
        CHECK((admission_kind = 'turn_write' AND turn_id IS NOT NULL
            AND runtime_owner_id IS NOT NULL AND runtime_last_heartbeat_at IS NOT NULL
            AND runtime_lease_expires_at IS NOT NULL AND runtime_lease_revision IS NOT NULL
            AND gc_try_parse_timestamptz(runtime_lease_expires_at)
              > gc_try_parse_timestamptz(runtime_last_heartbeat_at))
          OR (admission_kind = 'synchronous' AND turn_id IS NULL
            AND runtime_owner_id IS NULL AND runtime_last_heartbeat_at IS NULL
            AND runtime_lease_expires_at IS NULL AND runtime_lease_revision IS NULL
            AND runtime_lease_relinquished_at IS NULL)),
        CHECK(
          (status = 'active' AND terminal_authority_kind IS NULL
            AND terminal_runtime_owner_id IS NULL AND terminal_runtime_lease_revision IS NULL
            AND terminal_durable_run_id IS NULL AND terminal_durable_lease_owner_id IS NULL
            AND terminal_durable_attempt_count IS NULL AND terminal_durable_run_version IS NULL
            AND terminal_durable_run_status IS NULL AND terminal_lifecycle_intent_id IS NULL
            AND terminal_control_event_id IS NULL)
          OR (status IN ('completed', 'cancelled') AND (
            (terminal_authority_kind = 'synchronous'
              AND terminal_runtime_owner_id IS NULL AND terminal_runtime_lease_revision IS NULL
              AND terminal_durable_run_id IS NULL AND terminal_durable_lease_owner_id IS NULL
              AND terminal_durable_attempt_count IS NULL AND terminal_durable_run_version IS NULL
              AND terminal_durable_run_status IS NULL AND terminal_lifecycle_intent_id IS NULL
              AND terminal_control_event_id IS NULL)
            OR (terminal_authority_kind IN ('request_runtime', 'expired_recovery')
              AND terminal_runtime_owner_id IS NOT NULL AND terminal_runtime_lease_revision IS NOT NULL
              AND terminal_durable_run_id IS NULL AND terminal_durable_lease_owner_id IS NULL
              AND terminal_durable_attempt_count IS NULL AND terminal_durable_run_version IS NULL
              AND terminal_durable_run_status IS NULL AND terminal_lifecycle_intent_id IS NULL
              AND terminal_control_event_id IS NULL)
            OR (terminal_authority_kind = 'durable_run'
              AND terminal_runtime_owner_id IS NULL AND terminal_runtime_lease_revision IS NULL
              AND terminal_durable_run_id IS NOT NULL AND terminal_durable_lease_owner_id IS NOT NULL
              AND terminal_durable_attempt_count IS NOT NULL AND terminal_durable_run_version IS NOT NULL
              AND terminal_durable_run_status = 'running' AND terminal_lifecycle_intent_id IS NULL
              AND terminal_control_event_id IS NULL)
            OR (terminal_authority_kind = 'durable_terminal'
              AND terminal_runtime_owner_id IS NULL AND terminal_runtime_lease_revision IS NULL
              AND terminal_durable_run_id IS NOT NULL AND terminal_durable_lease_owner_id IS NULL
              AND terminal_durable_attempt_count IS NULL AND terminal_durable_run_version IS NOT NULL
              AND terminal_durable_run_status IN ('completed', 'failed', 'cancelled', 'dead_lettered')
              AND terminal_lifecycle_intent_id IS NULL AND terminal_control_event_id IS NULL)
            OR (terminal_authority_kind = 'lifecycle_delete'
              AND terminal_runtime_owner_id IS NULL AND terminal_runtime_lease_revision IS NULL
              AND terminal_durable_run_id IS NULL AND terminal_durable_lease_owner_id IS NULL
              AND terminal_durable_attempt_count IS NULL AND terminal_durable_run_version IS NULL
              AND terminal_durable_run_status IS NULL AND terminal_lifecycle_intent_id IS NOT NULL
              AND terminal_control_event_id IS NULL)
            OR (terminal_authority_kind = 'authority_superseded'
              AND terminal_runtime_owner_id IS NULL AND terminal_runtime_lease_revision IS NULL
              AND terminal_durable_run_id IS NULL AND terminal_durable_lease_owner_id IS NULL
              AND terminal_durable_attempt_count IS NULL AND terminal_durable_run_version IS NULL
              AND terminal_durable_run_status IS NULL AND terminal_lifecycle_intent_id IS NULL
              AND terminal_control_event_id IS NOT NULL)
            OR (terminal_authority_kind = 'post_commit_child_stage'
              AND terminal_runtime_owner_id IS NULL AND terminal_runtime_lease_revision IS NULL
              AND terminal_durable_run_id IS NOT NULL AND terminal_durable_lease_owner_id IS NOT NULL
              AND terminal_durable_attempt_count IS NOT NULL AND terminal_durable_run_version IS NOT NULL
              AND terminal_durable_run_status = 'running' AND terminal_lifecycle_intent_id IS NULL
              AND terminal_control_event_id IS NULL)
          ))
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_session_mutation_admissions_one_active_turn
        ON chat_session_mutation_admissions(session_id)
        WHERE admission_kind = 'turn_write' AND status = 'active';
      CREATE INDEX IF NOT EXISTS idx_chat_session_mutation_admissions_active
        ON chat_session_mutation_admissions(workspace_id, session_id, status, created_at, admission_id);

      CREATE TABLE IF NOT EXISTS chat_session_mutation_admission_events (
        event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 256),
        admission_id TEXT NOT NULL,
        session_incarnation_id TEXT NOT NULL CHECK(length(session_incarnation_id) BETWEEN 1 AND 320),
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT CHECK(turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 256),
        runtime_owner_id TEXT CHECK(runtime_owner_id IS NULL OR length(runtime_owner_id) BETWEEN 1 AND 256),
        runtime_lease_revision BIGINT CHECK(runtime_lease_revision IS NULL OR runtime_lease_revision > 0),
        event_sequence BIGINT NOT NULL CHECK(event_sequence IN (1, 2)),
        event_type TEXT NOT NULL CHECK(event_type IN ('admitted', 'completed', 'cancelled')),
        admission_kind TEXT NOT NULL CHECK(admission_kind IN ('synchronous', 'turn_write')),
        aggregate_revision BIGINT NOT NULL CHECK(aggregate_revision > 0),
        controller_generation BIGINT NOT NULL CHECK(controller_generation > 0),
        actor_kind TEXT NOT NULL CHECK(actor_kind IN ('operator', 'external_companion', 'system')),
        actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
        operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
        material_sha256 TEXT NOT NULL CHECK(material_sha256 ~ '^[0-9a-f]{64}$'),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        correlation_id TEXT NOT NULL CHECK(length(correlation_id) BETWEEN 1 AND 256),
        terminal_authority_kind TEXT,
        terminal_runtime_owner_id TEXT,
        terminal_runtime_lease_revision BIGINT,
        terminal_durable_run_id TEXT,
        terminal_durable_lease_owner_id TEXT,
        terminal_durable_attempt_count BIGINT,
        terminal_durable_run_version BIGINT,
        terminal_durable_run_status TEXT,
        terminal_lifecycle_intent_id TEXT,
        terminal_control_event_id TEXT,
        created_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(created_at) IS NOT NULL),
        UNIQUE(admission_id, event_sequence),
        FOREIGN KEY(admission_id) REFERENCES chat_session_mutation_admissions(admission_id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_chat_session_mutation_admission_events_admission
        ON chat_session_mutation_admission_events(admission_id, event_sequence);

      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM chat_routed_context_snapshots snapshot
          LEFT JOIN chat_turn_capability_profiles profile
            ON profile.profile_id = snapshot.capability_profile_id
          WHERE profile.profile_id IS NULL
            OR profile.turn_id <> snapshot.turn_id
            OR profile.session_id <> snapshot.session_id
            OR profile.workspace_id <> snapshot.workspace_id
            OR profile.profile_hash <> snapshot.capability_profile_hash
        ) THEN
          RAISE EXCEPTION 'legacy routed context snapshot and capability profile authority conflicts'
            USING ERRCODE = '23514';
        END IF;
      END;
      $$;

      CREATE TABLE IF NOT EXISTS chat_turn_session_incarnation_bindings (
        turn_id TEXT PRIMARY KEY CHECK(length(turn_id) BETWEEN 1 AND 256),
        workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
        session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
        session_incarnation_id TEXT NOT NULL CHECK(length(session_incarnation_id) BETWEEN 1 AND 320),
        admission_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        FOREIGN KEY(admission_id) REFERENCES chat_session_mutation_admissions(admission_id)
          ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
        CHECK(admission_id IS NOT NULL
          OR session_incarnation_id = 'legacy-session-incarnation:' || session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_turn_session_incarnation_bindings_session
        ON chat_turn_session_incarnation_bindings(workspace_id, session_id, session_incarnation_id, turn_id);

      INSERT INTO chat_turn_session_incarnation_bindings (
        turn_id, workspace_id, session_id, session_incarnation_id, admission_id, created_at
      )
      SELECT turn_id, workspace_id, session_id,
        'legacy-session-incarnation:' || session_id, NULL, created_at
      FROM chat_turn_capability_profiles
      ON CONFLICT(turn_id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS chat_turn_capability_profile_incarnation_bindings (
        profile_id TEXT PRIMARY KEY CHECK(length(profile_id) BETWEEN 1 AND 256),
        turn_id TEXT NOT NULL UNIQUE CHECK(length(turn_id) BETWEEN 1 AND 256),
        profile_hash TEXT NOT NULL CHECK(profile_hash ~ '^[0-9a-f]{64}$'),
        created_at TEXT NOT NULL,
        FOREIGN KEY(turn_id) REFERENCES chat_turn_session_incarnation_bindings(turn_id) ON DELETE RESTRICT,
        FOREIGN KEY(profile_id) REFERENCES chat_turn_capability_profiles(profile_id)
          ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
      );

      INSERT INTO chat_turn_capability_profile_incarnation_bindings (
        profile_id, turn_id, profile_hash, created_at
      )
      SELECT profile_id, turn_id, profile_hash, created_at
      FROM chat_turn_capability_profiles
      ON CONFLICT(profile_id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS chat_turn_mutation_admission_durable_bindings (
        admission_id TEXT PRIMARY KEY CHECK(length(admission_id) BETWEEN 1 AND 256),
        turn_id TEXT NOT NULL UNIQUE CHECK(length(turn_id) BETWEEN 1 AND 256),
        workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
        session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
        session_incarnation_id TEXT NOT NULL CHECK(length(session_incarnation_id) BETWEEN 1 AND 320),
        durable_run_id TEXT NOT NULL UNIQUE CHECK(length(durable_run_id) BETWEEN 1 AND 256),
        created_at TEXT NOT NULL,
        FOREIGN KEY(admission_id) REFERENCES chat_session_mutation_admissions(admission_id) ON DELETE RESTRICT,
        FOREIGN KEY(turn_id) REFERENCES chat_turn_session_incarnation_bindings(turn_id) ON DELETE RESTRICT,
        FOREIGN KEY(durable_run_id) REFERENCES durable_runs(run_id)
          ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
      );

      CREATE TABLE IF NOT EXISTS chat_turn_user_input_continuation_seals (
        seal_id TEXT PRIMARY KEY CHECK(length(seal_id) BETWEEN 1 AND 256),
        version BIGINT NOT NULL CHECK(version = 1),
        admission_id TEXT NOT NULL CHECK(length(admission_id) BETWEEN 1 AND 256),
        session_incarnation_id TEXT NOT NULL CHECK(length(session_incarnation_id) BETWEEN 1 AND 320),
        workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
        session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
        turn_id TEXT NOT NULL CHECK(length(turn_id) BETWEEN 1 AND 256),
        durable_run_id TEXT NOT NULL CHECK(length(durable_run_id) BETWEEN 1 AND 256),
        prompt_id TEXT NOT NULL CHECK(length(prompt_id) BETWEEN 1 AND 256),
        event_key TEXT NOT NULL CHECK(event_key = 'chat.user_input.resolved'),
        correlation_id TEXT NOT NULL CHECK(length(correlation_id) BETWEEN 1 AND 256),
        resume_record_sha256 TEXT NOT NULL CHECK(resume_record_sha256 ~ '^[0-9a-f]{64}$'),
        responder_actor_id TEXT NOT NULL CHECK(length(responder_actor_id) BETWEEN 1 AND 256),
        responder_auth_actor_source TEXT NOT NULL CHECK(responder_auth_actor_source IN (
          'none', 'token', 'basic', 'loopback', 'sse', 'device', 'companion', 'a2a_peer'
        )),
        waiting_run_version BIGINT NOT NULL CHECK(waiting_run_version > 0),
        queued_run_version BIGINT NOT NULL CHECK(queued_run_version = waiting_run_version + 1),
        resolved_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(resolved_at) IS NOT NULL),
        material_sha256 TEXT NOT NULL CHECK(material_sha256 ~ '^[0-9a-f]{64}$'),
        UNIQUE(admission_id, durable_run_id, prompt_id),
        UNIQUE(durable_run_id, prompt_id),
        CHECK(correlation_id = prompt_id),
        FOREIGN KEY(admission_id) REFERENCES chat_session_mutation_admissions(admission_id) ON DELETE RESTRICT,
        FOREIGN KEY(turn_id) REFERENCES chat_turn_session_incarnation_bindings(turn_id) ON DELETE RESTRICT,
        FOREIGN KEY(durable_run_id) REFERENCES durable_runs(run_id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_chat_turn_user_input_continuation_seals_run
        ON chat_turn_user_input_continuation_seals(durable_run_id, prompt_id);

      CREATE OR REPLACE FUNCTION gc_reject_session_lifecycle_immutable_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'session lifecycle authority is immutable' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_session_lifecycle_intent_insert_guard()
      RETURNS trigger AS $$
      BEGIN
        IF gc_try_parse_timestamptz(NEW.created_at) IS NULL
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.created_at) - clock_timestamp()))) > 1
          OR (NEW.intent_kind IN ('initialize', 'reactivate')
            AND NEW.session_incarnation_id <> NEW.intent_id)
          OR (NEW.intent_kind = 'delete' AND NOT EXISTS (
            SELECT 1 FROM chat_session_meta meta
            JOIN chat_session_control_grants control
              ON control.session_id = meta.session_id AND control.is_current = 1
            WHERE meta.session_id = NEW.session_id AND meta.workspace_id = NEW.workspace_id
              AND meta.revision = NEW.expected_revision AND meta.deletion_intent_id IS NULL
              AND NEW.session_incarnation_id = COALESCE(
                meta.lifecycle_intent_id,
                'legacy-session-incarnation:' || meta.session_id
              )
              AND control.workspace_id = NEW.workspace_id
              AND control.generation = NEW.expected_generation
              AND control.owner_kind = 'operator' AND control.lease_state = 'operator_active'
          ))
          OR EXISTS (SELECT 1 FROM chat_session_control_events WHERE idempotency_key = NEW.idempotency_key) THEN
          RAISE EXCEPTION 'chat session lifecycle intent invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_session_lifecycle_intents_insert_guard
        BEFORE INSERT ON chat_session_lifecycle_intents FOR EACH ROW
        EXECUTE FUNCTION gc_session_lifecycle_intent_insert_guard();
      CREATE TRIGGER trg_chat_session_lifecycle_intents_no_update
        BEFORE UPDATE ON chat_session_lifecycle_intents FOR EACH ROW
        EXECUTE FUNCTION gc_reject_session_lifecycle_immutable_mutation();
      CREATE TRIGGER trg_chat_session_lifecycle_intents_no_delete
        BEFORE DELETE ON chat_session_lifecycle_intents FOR EACH ROW
        EXECUTE FUNCTION gc_reject_session_lifecycle_immutable_mutation();

      CREATE OR REPLACE FUNCTION gc_chat_session_meta_lifecycle_guard()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          PERFORM pg_advisory_xact_lock(hashtextextended(NEW.session_id, 411));
          IF NEW.lifecycle_intent_id IS NULL OR NEW.deletion_intent_id IS NOT NULL OR NOT EXISTS (
            SELECT 1 FROM chat_session_lifecycle_intents intent
            WHERE intent.intent_id = NEW.lifecycle_intent_id
              AND intent.workspace_id = NEW.workspace_id AND intent.session_id = NEW.session_id
              AND intent.intent_kind IN ('initialize', 'reactivate')
              AND intent.session_incarnation_id = intent.intent_id
              AND NOT EXISTS (SELECT 1 FROM chat_session_control_events event_row
                WHERE event_row.idempotency_key = intent.idempotency_key)
              AND ((intent.intent_kind = 'initialize' AND intent.next_generation = 1
                    AND NOT EXISTS (SELECT 1 FROM chat_session_control_grants prior
                      WHERE prior.session_id = NEW.session_id))
                OR (intent.intent_kind = 'reactivate'
                    AND NOT EXISTS (SELECT 1 FROM chat_session_control_grants current_row
                      WHERE current_row.session_id = NEW.session_id AND current_row.is_current = 1)
                    AND (SELECT MAX(prior.generation) FROM chat_session_control_grants prior
                         WHERE prior.session_id = NEW.session_id) = intent.expected_generation
                    AND EXISTS (SELECT 1 FROM chat_session_control_grants terminal
                      WHERE terminal.session_id = NEW.session_id AND terminal.generation = intent.expected_generation
                        AND terminal.workspace_id = NEW.workspace_id AND terminal.is_current = 0
                        AND terminal.owner_kind = 'operator' AND terminal.lease_state = 'deleted')))
          ) THEN
            RAISE EXCEPTION 'chat session metadata requires an exact lifecycle intent' USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        ELSIF TG_OP = 'UPDATE' THEN
          IF NEW.workspace_id <> OLD.workspace_id
            OR NEW.session_id <> OLD.session_id
            OR NEW.lifecycle_intent_id IS DISTINCT FROM OLD.lifecycle_intent_id
            OR (NEW.deletion_intent_id IS DISTINCT FROM OLD.deletion_intent_id AND NOT (
              OLD.deletion_intent_id IS NULL AND NEW.deletion_intent_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM chat_session_lifecycle_intents intent
                JOIN chat_session_control_grants control
                  ON control.session_id = OLD.session_id AND control.is_current = 1
                WHERE intent.intent_id = NEW.deletion_intent_id AND intent.intent_kind = 'delete'
                  AND intent.workspace_id = OLD.workspace_id AND intent.session_id = OLD.session_id
                  AND intent.session_incarnation_id = COALESCE(
                    OLD.lifecycle_intent_id,
                    'legacy-session-incarnation:' || OLD.session_id
                  )
                  AND intent.expected_revision = OLD.revision
                  AND intent.expected_generation = control.generation
                  AND control.workspace_id = OLD.workspace_id AND control.owner_kind = 'operator'
                  AND control.lease_state = 'operator_active'
                  AND NOT EXISTS (SELECT 1 FROM chat_session_control_events event_row
                    WHERE event_row.idempotency_key = intent.idempotency_key)
              )
            )) THEN
            RAISE EXCEPTION 'chat session workspace is immutable and lifecycle intent replacement is restricted'
              USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM chat_session_lifecycle_intents intent
          JOIN chat_session_control_grants terminal
            ON terminal.session_id = OLD.session_id AND terminal.generation = intent.expected_generation
          JOIN chat_session_control_events event_row
            ON event_row.session_id = OLD.session_id AND event_row.idempotency_key = intent.idempotency_key
          WHERE intent.intent_id = OLD.deletion_intent_id AND intent.intent_kind = 'delete'
            AND intent.workspace_id = OLD.workspace_id AND intent.session_id = OLD.session_id
            AND intent.session_incarnation_id = COALESCE(
              OLD.lifecycle_intent_id,
              'legacy-session-incarnation:' || OLD.session_id
            )
            AND intent.expected_revision = OLD.revision
            AND terminal.workspace_id = OLD.workspace_id AND terminal.is_current = 0
            AND terminal.owner_kind = 'operator' AND terminal.lease_state = 'deleted'
            AND terminal.terminal_at = intent.created_at
            AND event_row.reason_code = 'session_deleted'
            AND event_row.previous_generation = intent.expected_generation
            AND event_row.next_generation = intent.expected_generation
            AND event_row.created_at = intent.created_at
            AND NOT EXISTS (SELECT 1 FROM chat_session_control_grants current_row
              WHERE current_row.session_id = OLD.session_id AND current_row.is_current = 1)
            AND NOT EXISTS (SELECT 1 FROM chat_session_control_requests request_row
              WHERE request_row.session_id = OLD.session_id AND request_row.status = 'pending')
            AND NOT EXISTS (SELECT 1 FROM chat_session_mutation_admissions admission
              WHERE admission.session_id = OLD.session_id AND admission.status = 'active')
        ) THEN
          RAISE EXCEPTION 'chat session metadata delete requires terminal lifecycle evidence' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_session_meta_lifecycle_guard
        BEFORE INSERT OR UPDATE OR DELETE ON chat_session_meta FOR EACH ROW
        EXECUTE FUNCTION gc_chat_session_meta_lifecycle_guard();

      CREATE OR REPLACE FUNCTION gc_chat_session_meta_lifecycle_after_insert()
      RETURNS trigger AS $$
      DECLARE intent chat_session_lifecycle_intents%ROWTYPE;
      DECLARE next_sequence BIGINT;
      BEGIN
        SELECT * INTO STRICT intent FROM chat_session_lifecycle_intents WHERE intent_id = NEW.lifecycle_intent_id;
        INSERT INTO chat_session_control_grants (
          workspace_id, session_id, generation, is_current, owner_kind, lease_state,
          requested_capabilities_json, requested_capabilities_sha256,
          effective_capabilities_json, effective_capabilities_sha256,
          control_revision, transition_idempotency_key, transition_request_sha256, created_at, updated_at
        ) VALUES (
          intent.workspace_id, intent.session_id, intent.next_generation, 1, 'operator', 'operator_active',
          '[]', '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
          '[]', '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
          1, intent.idempotency_key, intent.request_sha256, intent.created_at, intent.created_at
        );
        SELECT COALESCE(MAX(event_sequence), 0) + 1 INTO next_sequence
        FROM chat_session_control_events WHERE session_id = intent.session_id;
        INSERT INTO chat_session_control_events (
          event_id, workspace_id, session_id, event_sequence, request_id,
          previous_generation, next_generation, previous_owner_kind, next_owner_kind,
          previous_lease_state, next_lease_state, reason_code, actor_kind, actor_id,
          companion_session_id, device_grant_id, idempotency_key, request_sha256, correlation_id, created_at
        ) VALUES (
          intent.event_id, intent.workspace_id, intent.session_id, next_sequence, NULL,
          intent.expected_generation, intent.next_generation,
          CASE WHEN intent.intent_kind = 'reactivate' THEN 'operator' ELSE NULL END, 'operator',
          CASE WHEN intent.intent_kind = 'reactivate' THEN 'deleted' ELSE NULL END, 'operator_active',
          CASE WHEN intent.intent_kind = 'initialize' THEN 'session_initialized' ELSE 'session_reactivated' END,
          intent.actor_kind, intent.actor_id, NULL, NULL, intent.idempotency_key,
          intent.request_sha256, intent.correlation_id, intent.created_at
        );
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_session_meta_lifecycle_after_insert
        AFTER INSERT ON chat_session_meta FOR EACH ROW EXECUTE FUNCTION gc_chat_session_meta_lifecycle_after_insert();

      CREATE OR REPLACE FUNCTION gc_session_control_operator_generation_lifecycle_guard()
      RETURNS trigger AS $$
      DECLARE prior_generation BIGINT;
      DECLARE prior_state TEXT;
      BEGIN
        IF NEW.owner_kind <> 'operator' THEN RETURN NEW; END IF;
        SELECT generation, lease_state INTO prior_generation, prior_state
        FROM chat_session_control_grants WHERE session_id = NEW.session_id
        ORDER BY generation DESC LIMIT 1;
        IF (prior_generation IS NULL OR prior_state = 'deleted') AND NOT EXISTS (
          SELECT 1 FROM chat_session_meta meta
          JOIN chat_session_lifecycle_intents intent ON intent.intent_id = meta.lifecycle_intent_id
          WHERE meta.session_id = NEW.session_id AND meta.workspace_id = NEW.workspace_id
            AND intent.intent_kind IN ('initialize', 'reactivate')
            AND intent.next_generation = NEW.generation
            AND intent.idempotency_key = NEW.transition_idempotency_key
            AND intent.request_sha256 = NEW.transition_request_sha256
        ) THEN
          RAISE EXCEPTION 'operator generation requires exact lifecycle intent' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_session_control_operator_generation_lifecycle_guard
        BEFORE INSERT ON chat_session_control_grants FOR EACH ROW
        EXECUTE FUNCTION gc_session_control_operator_generation_lifecycle_guard();

      CREATE OR REPLACE FUNCTION gc_session_mutation_admission_guard()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          PERFORM pg_advisory_xact_lock(hashtextextended(NEW.session_id, 411));
          IF NEW.status <> 'active'
            OR gc_try_parse_timestamptz(NEW.created_at) IS NULL
            OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.created_at) - clock_timestamp()))) > 1
            OR (NEW.admission_kind = 'turn_write' AND (
              NEW.runtime_lease_revision <> 1
              OR NEW.runtime_lease_relinquished_at IS NOT NULL
              OR NEW.runtime_last_heartbeat_at <> NEW.created_at
              OR abs(EXTRACT(EPOCH FROM (
                gc_try_parse_timestamptz(NEW.runtime_last_heartbeat_at) - clock_timestamp()
              ))) > 1
              OR abs(EXTRACT(EPOCH FROM (
                gc_try_parse_timestamptz(NEW.runtime_lease_expires_at) - clock_timestamp()
              )) - 60) > 1
            ))
            OR NOT EXISTS (
              SELECT 1 FROM chat_session_meta meta
              JOIN chat_session_control_grants control
                ON control.session_id = meta.session_id AND control.is_current = 1
              WHERE meta.session_id = NEW.session_id AND meta.workspace_id = NEW.workspace_id
                AND meta.revision = NEW.aggregate_revision AND meta.deletion_intent_id IS NULL
                AND NEW.session_incarnation_id = COALESCE(
                  meta.lifecycle_intent_id,
                  'legacy-session-incarnation:' || meta.session_id
                )
                AND control.workspace_id = NEW.workspace_id
                AND control.generation = NEW.controller_generation
                AND ((NEW.actor_kind IN ('operator', 'system')
                      AND control.owner_kind = 'operator' AND control.lease_state = 'operator_active')
                  OR (NEW.actor_kind = 'external_companion'
                      AND control.owner_kind = 'external_companion' AND control.lease_state = 'external_live'
                      AND control.companion_session_id = NEW.actor_id))
            ) THEN
            RAISE EXCEPTION 'session mutation admission authority invariant violated' USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.admission_id <> OLD.admission_id OR NEW.workspace_id <> OLD.workspace_id
          OR NEW.session_id <> OLD.session_id
          OR NEW.session_incarnation_id <> OLD.session_incarnation_id
          OR NEW.turn_id IS DISTINCT FROM OLD.turn_id
          OR NEW.runtime_owner_id IS DISTINCT FROM OLD.runtime_owner_id
          OR NEW.admission_kind <> OLD.admission_kind
          OR NEW.aggregate_revision <> OLD.aggregate_revision
          OR NEW.controller_generation <> OLD.controller_generation
          OR NEW.actor_kind <> OLD.actor_kind OR NEW.actor_id <> OLD.actor_id
          OR NEW.operation <> OLD.operation OR NEW.material_sha256 <> OLD.material_sha256
          OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.request_sha256 <> OLD.request_sha256
          OR NEW.correlation_id <> OLD.correlation_id OR NEW.admit_event_id <> OLD.admit_event_id
          OR NEW.created_at <> OLD.created_at OR OLD.status <> 'active'
          OR NOT (
            (NEW.status = 'active' AND OLD.status = 'active'
              AND OLD.runtime_lease_relinquished_at IS NULL
              AND gc_try_parse_timestamptz(OLD.runtime_lease_expires_at) > clock_timestamp()
              AND NEW.runtime_lease_relinquished_at IS NULL
              AND NEW.runtime_lease_revision = OLD.runtime_lease_revision + 1
              AND gc_try_parse_timestamptz(NEW.runtime_last_heartbeat_at)
                >= gc_try_parse_timestamptz(OLD.runtime_last_heartbeat_at)
              AND abs(EXTRACT(EPOCH FROM (
                gc_try_parse_timestamptz(NEW.runtime_last_heartbeat_at) - clock_timestamp()
              ))) <= 1
              AND abs(EXTRACT(EPOCH FROM (
                gc_try_parse_timestamptz(NEW.runtime_lease_expires_at) - clock_timestamp()
              )) - 60) <= 1
              AND NEW.closed_at IS NOT DISTINCT FROM OLD.closed_at
              AND NEW.terminal_actor_id IS NOT DISTINCT FROM OLD.terminal_actor_id
              AND NEW.terminal_event_id IS NOT DISTINCT FROM OLD.terminal_event_id
              AND NEW.terminal_idempotency_key IS NOT DISTINCT FROM OLD.terminal_idempotency_key
              AND NEW.terminal_correlation_id IS NOT DISTINCT FROM OLD.terminal_correlation_id
              AND NOT EXISTS (
                SELECT 1 FROM chat_turn_mutation_admission_durable_bindings durable_binding
                WHERE durable_binding.admission_id = OLD.admission_id
              ))
            OR (NEW.status = 'active' AND OLD.status = 'active'
              AND OLD.runtime_lease_relinquished_at IS NULL
              AND NEW.runtime_lease_relinquished_at IS NOT NULL
              AND abs(EXTRACT(EPOCH FROM (
                gc_try_parse_timestamptz(NEW.runtime_lease_relinquished_at) - clock_timestamp()
              ))) <= 1
              AND NEW.runtime_lease_revision = OLD.runtime_lease_revision + 1
              AND NEW.runtime_last_heartbeat_at = OLD.runtime_last_heartbeat_at
              AND NEW.runtime_lease_expires_at = OLD.runtime_lease_expires_at
              AND NEW.closed_at IS NOT DISTINCT FROM OLD.closed_at
              AND NEW.terminal_actor_id IS NOT DISTINCT FROM OLD.terminal_actor_id
              AND NEW.terminal_event_id IS NOT DISTINCT FROM OLD.terminal_event_id
              AND NEW.terminal_idempotency_key IS NOT DISTINCT FROM OLD.terminal_idempotency_key
              AND NEW.terminal_correlation_id IS NOT DISTINCT FROM OLD.terminal_correlation_id
              AND EXISTS (
                SELECT 1 FROM chat_turn_mutation_admission_durable_bindings durable_binding
                WHERE durable_binding.admission_id = OLD.admission_id
                  AND durable_binding.turn_id = OLD.turn_id
                  AND durable_binding.session_incarnation_id = OLD.session_incarnation_id
              ))
            OR (NEW.status IN ('completed', 'cancelled')
              AND NEW.runtime_last_heartbeat_at IS NOT DISTINCT FROM OLD.runtime_last_heartbeat_at
              AND NEW.runtime_lease_expires_at IS NOT DISTINCT FROM OLD.runtime_lease_expires_at
              AND NEW.runtime_lease_revision IS NOT DISTINCT FROM OLD.runtime_lease_revision
              AND NEW.runtime_lease_relinquished_at IS NOT DISTINCT FROM OLD.runtime_lease_relinquished_at
              AND gc_try_parse_timestamptz(NEW.closed_at) IS NOT NULL
              AND abs(EXTRACT(EPOCH FROM (
                gc_try_parse_timestamptz(NEW.closed_at) - clock_timestamp()
              ))) <= 1
              AND (
                (OLD.admission_kind = 'synchronous' AND NEW.terminal_authority_kind = 'synchronous')
                OR (OLD.admission_kind = 'turn_write' AND NEW.terminal_authority_kind = 'request_runtime'
                  AND OLD.runtime_lease_relinquished_at IS NULL
                  AND gc_try_parse_timestamptz(OLD.runtime_lease_expires_at) > clock_timestamp()
                  AND NEW.terminal_runtime_owner_id = OLD.runtime_owner_id
                  AND NEW.terminal_runtime_lease_revision = OLD.runtime_lease_revision
                  AND NOT EXISTS (
                    SELECT 1 FROM chat_turn_mutation_admission_durable_bindings durable_binding
                    WHERE durable_binding.admission_id = OLD.admission_id
                  ))
                OR (OLD.admission_kind = 'turn_write' AND NEW.terminal_authority_kind = 'expired_recovery'
                  AND NEW.status = 'cancelled'
                  AND OLD.runtime_lease_relinquished_at IS NULL
                  AND gc_try_parse_timestamptz(OLD.runtime_lease_expires_at) <= clock_timestamp()
                  AND NEW.terminal_runtime_owner_id = OLD.runtime_owner_id
                  AND NEW.terminal_runtime_lease_revision = OLD.runtime_lease_revision
                  AND NOT EXISTS (
                    SELECT 1 FROM chat_turn_mutation_admission_durable_bindings durable_binding
                    WHERE durable_binding.admission_id = OLD.admission_id
                  ))
                OR (OLD.admission_kind = 'turn_write' AND NEW.terminal_authority_kind = 'durable_run'
                  AND EXISTS (
                    SELECT 1
                    FROM chat_turn_mutation_admission_durable_bindings durable_binding
                    JOIN durable_runs run ON run.run_id = durable_binding.durable_run_id
                    WHERE durable_binding.admission_id = OLD.admission_id
                      AND durable_binding.turn_id = OLD.turn_id
                      AND durable_binding.workspace_id = OLD.workspace_id
                      AND durable_binding.session_id = OLD.session_id
                      AND durable_binding.session_incarnation_id = OLD.session_incarnation_id
                      AND run.run_id = NEW.terminal_durable_run_id
                      AND run.workflow_key = 'chat.turn.execute' AND run.status = 'running'
                      AND run.lease_owner_id = NEW.terminal_durable_lease_owner_id
                      AND run.attempt_count = NEW.terminal_durable_attempt_count
                      AND run.version = NEW.terminal_durable_run_version
                      AND gc_try_parse_timestamptz(run.lease_expires_at) > clock_timestamp()
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'version' = 'chat.turn.execute.v2'
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'admissionId' = OLD.admission_id
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'sessionIncarnationId' = OLD.session_incarnation_id
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'admissionMaterialSha256' = OLD.material_sha256
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'workspaceId' = OLD.workspace_id
                      AND jsonb_typeof(gc_try_parse_jsonb(run.payload_json) -> 'admissionAggregateRevision') = 'number'
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'admissionAggregateRevision' ~ '^[1-9][0-9]*$'
                      AND (gc_try_parse_jsonb(run.payload_json) ->> 'admissionAggregateRevision')::BIGINT
                        = OLD.aggregate_revision
                      AND jsonb_typeof(gc_try_parse_jsonb(run.payload_json) -> 'admissionControllerGeneration') = 'number'
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'admissionControllerGeneration' ~ '^[1-9][0-9]*$'
                      AND (gc_try_parse_jsonb(run.payload_json) ->> 'admissionControllerGeneration')::BIGINT
                        = OLD.controller_generation
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'sessionId' = OLD.session_id
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'turnId' = OLD.turn_id
                  ))
                OR (OLD.admission_kind = 'turn_write' AND NEW.terminal_authority_kind = 'durable_terminal'
                  AND EXISTS (
                    SELECT 1
                    FROM chat_turn_mutation_admission_durable_bindings durable_binding
                    JOIN durable_runs run ON run.run_id = durable_binding.durable_run_id
                    WHERE durable_binding.admission_id = OLD.admission_id
                      AND durable_binding.turn_id = OLD.turn_id
                      AND durable_binding.workspace_id = OLD.workspace_id
                      AND durable_binding.session_id = OLD.session_id
                      AND durable_binding.session_incarnation_id = OLD.session_incarnation_id
                      AND run.run_id = NEW.terminal_durable_run_id
                      AND run.workflow_key = 'chat.turn.execute'
                      AND run.status = NEW.terminal_durable_run_status
                      AND run.status IN ('completed', 'failed', 'cancelled', 'dead_lettered')
                      AND ((run.status = 'completed' AND NEW.status = 'completed')
                        OR (run.status <> 'completed' AND NEW.status = 'cancelled'))
                      AND run.version = NEW.terminal_durable_run_version
                      AND run.lease_owner_id IS NULL AND run.lease_expires_at IS NULL
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'version' = 'chat.turn.execute.v2'
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'admissionId' = OLD.admission_id
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'sessionIncarnationId' = OLD.session_incarnation_id
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'admissionMaterialSha256' = OLD.material_sha256
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'workspaceId' = OLD.workspace_id
                      AND jsonb_typeof(gc_try_parse_jsonb(run.payload_json) -> 'admissionAggregateRevision') = 'number'
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'admissionAggregateRevision' ~ '^[1-9][0-9]*$'
                      AND (gc_try_parse_jsonb(run.payload_json) ->> 'admissionAggregateRevision')::BIGINT
                        = OLD.aggregate_revision
                      AND jsonb_typeof(gc_try_parse_jsonb(run.payload_json) -> 'admissionControllerGeneration') = 'number'
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'admissionControllerGeneration' ~ '^[1-9][0-9]*$'
                      AND (gc_try_parse_jsonb(run.payload_json) ->> 'admissionControllerGeneration')::BIGINT
                        = OLD.controller_generation
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'sessionId' = OLD.session_id
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'turnId' = OLD.turn_id
                      AND gc_try_parse_jsonb(run.metadata_json) ? 'chatTurnAdmissionHandoff'
                      AND NOT (gc_try_parse_jsonb(run.metadata_json) ? 'linkedFinalizationPending')
                      AND NOT (gc_try_parse_jsonb(run.metadata_json) ? 'autonomousChatPostCommitPending')
                      AND NOT (gc_try_parse_jsonb(run.metadata_json) ? 'generalChatPostCommitPending')
                      AND jsonb_typeof(gc_try_parse_jsonb(run.metadata_json)
                        -> 'chatTurnAdmissionHandoff') = 'object'
                      AND (gc_try_parse_jsonb(run.metadata_json) -> 'chatTurnAdmissionHandoff') ?& ARRAY[
                        'admissionId', 'childRunIds', 'childRunIdsSha256', 'committedAt',
                        'parentLocalEffectsStatus', 'parentRunId', 'postCommitGenerationId',
                        'sessionIncarnationId', 'turnId', 'version'
                      ]
                      AND (gc_try_parse_jsonb(run.metadata_json) -> 'chatTurnAdmissionHandoff') - ARRAY[
                        'admissionId', 'childRunIds', 'childRunIdsSha256', 'committedAt',
                        'parentLocalEffectsStatus', 'parentRunId', 'postCommitGenerationId',
                        'sessionIncarnationId', 'turnId', 'version'
                      ] = '{}'::JSONB
                      AND jsonb_typeof(gc_try_parse_jsonb(run.metadata_json)
                        #> '{chatTurnAdmissionHandoff,version}') = 'number'
                      AND gc_try_parse_jsonb(run.metadata_json) #>> '{chatTurnAdmissionHandoff,version}' = '1'
                      AND gc_try_parse_jsonb(run.metadata_json) #>> '{chatTurnAdmissionHandoff,admissionId}'
                        = OLD.admission_id
                      AND gc_try_parse_jsonb(run.metadata_json) #>> '{chatTurnAdmissionHandoff,sessionIncarnationId}'
                        = OLD.session_incarnation_id
                      AND gc_try_parse_jsonb(run.metadata_json) #>> '{chatTurnAdmissionHandoff,turnId}' = OLD.turn_id
                      AND gc_try_parse_jsonb(run.metadata_json) #>> '{chatTurnAdmissionHandoff,parentRunId}' = run.run_id
                      AND jsonb_typeof(gc_try_parse_jsonb(run.metadata_json)
                        #> '{chatTurnAdmissionHandoff,postCommitGenerationId}') = 'string'
                      AND length(gc_try_parse_jsonb(run.metadata_json)
                        #>> '{chatTurnAdmissionHandoff,postCommitGenerationId}') > 0
                      AND gc_try_parse_jsonb(run.metadata_json)
                        #>> '{chatTurnAdmissionHandoff,parentLocalEffectsStatus}' = 'settled'
                      AND jsonb_typeof(gc_try_parse_jsonb(run.metadata_json)
                        -> 'generalChatPostCommit') = 'object'
                      AND gc_try_parse_jsonb(run.metadata_json)
                        #>> '{generalChatPostCommit,generationId}' = gc_try_parse_jsonb(run.metadata_json)
                          #>> '{chatTurnAdmissionHandoff,postCommitGenerationId}'
                      AND gc_try_parse_jsonb(run.metadata_json)
                        #>> '{generalChatPostCommit,parentLocalEffectsStatus}' = 'settled'
                      AND jsonb_typeof(gc_try_parse_jsonb(run.metadata_json)
                        #> '{generalChatPostCommit,completedEffects}') = 'array'
                      AND (
                        SELECT COUNT(DISTINCT local_effect.value #>> '{}')
                        FROM jsonb_array_elements(gc_try_parse_jsonb(run.metadata_json)
                          #> '{generalChatPostCommit,completedEffects}') local_effect(value)
                        WHERE jsonb_typeof(local_effect.value) = 'string'
                          AND local_effect.value #>> '{}' IN ('capability_gap', 'realtime', 'agent_end')
                      ) = 3
                      AND jsonb_typeof(gc_try_parse_jsonb(run.metadata_json)
                        #> '{chatTurnAdmissionHandoff,childRunIds}') = 'array'
                      AND encode(sha256(convert_to((
                        SELECT '[' || COALESCE(string_agg(marker_child.value::TEXT, ',' ORDER BY marker_child.ordinal), '') || ']'
                        FROM jsonb_array_elements(gc_try_parse_jsonb(run.metadata_json)
                          #> '{chatTurnAdmissionHandoff,childRunIds}')
                          WITH ORDINALITY marker_child(value, ordinal)
                      ), 'UTF8')), 'hex') = gc_try_parse_jsonb(run.metadata_json)
                        #>> '{chatTurnAdmissionHandoff,childRunIdsSha256}'
                      AND gc_try_parse_timestamptz(gc_try_parse_jsonb(run.metadata_json)
                        #>> '{chatTurnAdmissionHandoff,committedAt}') IS NOT NULL
                      AND NOT EXISTS (
                        SELECT 1
                        FROM jsonb_array_elements(gc_try_parse_jsonb(run.metadata_json)
                          #> '{chatTurnAdmissionHandoff,childRunIds}') WITH ORDINALITY left_child(value, ordinal)
                        JOIN jsonb_array_elements(gc_try_parse_jsonb(run.metadata_json)
                          #> '{chatTurnAdmissionHandoff,childRunIds}') WITH ORDINALITY right_child(value, ordinal)
                          ON left_child.ordinal < right_child.ordinal
                        WHERE jsonb_typeof(left_child.value) <> 'string'
                          OR jsonb_typeof(right_child.value) <> 'string'
                          OR length(left_child.value #>> '{}') = 0
                          OR length(right_child.value #>> '{}') = 0
                          OR left_child.value #>> '{}' >= right_child.value #>> '{}'
                      )
                      AND NOT EXISTS (
                        SELECT 1
                        FROM jsonb_array_elements(gc_try_parse_jsonb(run.metadata_json)
                          #> '{chatTurnAdmissionHandoff,childRunIds}') marker_child(value)
                        WHERE jsonb_typeof(marker_child.value) <> 'string' OR NOT EXISTS (
                          SELECT 1
                          FROM durable_runs child_run
                          JOIN chat_session_mutation_admissions child_admission
                            ON child_admission.admission_id = gc_try_parse_jsonb(child_run.payload_json)
                              #>> '{childAdmission,admissionId}'
                          WHERE child_run.run_id = marker_child.value #>> '{}'
                            AND child_run.workflow_key = 'chat.post_commit.effect'
                            AND gc_try_parse_jsonb(child_run.payload_json) ->> 'version'
                              = 'chat.post_commit.effect.v2'
                            AND gc_try_parse_jsonb(child_run.payload_json) ->> 'parentRunId' = run.run_id
                            AND gc_try_parse_jsonb(child_run.payload_json) ->> 'postCommitGenerationId'
                              = gc_try_parse_jsonb(run.metadata_json)
                                #>> '{chatTurnAdmissionHandoff,postCommitGenerationId}'
                            AND jsonb_typeof(gc_try_parse_jsonb(child_run.payload_json) -> 'effect') = 'string'
                            AND gc_try_parse_jsonb(child_run.payload_json) ->> 'effect' IN (
                              'commitments', 'background_review', 'memory_maintenance'
                            )
                            AND jsonb_typeof(gc_try_parse_jsonb(child_run.payload_json) -> 'traceStatus') = 'string'
                            AND length(gc_try_parse_jsonb(child_run.payload_json) ->> 'traceStatus') > 0
                            AND gc_try_parse_jsonb(child_run.payload_json) ->> 'effect'
                              = gc_try_parse_jsonb(child_run.metadata_json) ->> 'effect'
                            AND gc_try_parse_jsonb(child_run.payload_json) ->> 'parentRunId'
                              = gc_try_parse_jsonb(child_run.metadata_json) ->> 'parentRunId'
                            AND gc_try_parse_jsonb(child_run.payload_json) ->> 'postCommitGenerationId'
                              = gc_try_parse_jsonb(child_run.metadata_json) ->> 'postCommitGenerationId'
                            AND gc_try_parse_jsonb(child_run.payload_json) -> 'childAdmission'
                              = gc_try_parse_jsonb(child_run.metadata_json) -> 'childAdmission'
                            AND gc_try_parse_jsonb(child_run.payload_json) -> 'postCommitEligibility'
                              = gc_try_parse_jsonb(child_run.metadata_json) -> 'postCommitEligibility'
                            AND gc_try_parse_jsonb(child_run.metadata_json) ->> 'workspaceId' = OLD.workspace_id
                            AND gc_try_parse_jsonb(child_run.metadata_json) ->> 'sessionId' = OLD.session_id
                            AND gc_try_parse_jsonb(child_run.metadata_json) ->> 'turnId' = OLD.turn_id
                            AND jsonb_typeof(gc_try_parse_jsonb(child_run.payload_json)
                              -> 'childAdmission') = 'object'
                            AND (gc_try_parse_jsonb(child_run.payload_json) -> 'childAdmission') ?& ARRAY[
                              'actorId', 'actorKind', 'admissionId', 'aggregateRevision',
                              'controllerGeneration', 'materialSha256', 'operation', 'sessionId',
                              'sessionIncarnationId', 'workspaceId'
                            ]
                            AND (gc_try_parse_jsonb(child_run.payload_json) -> 'childAdmission') - ARRAY[
                              'actorId', 'actorKind', 'admissionId', 'aggregateRevision',
                              'controllerGeneration', 'materialSha256', 'operation', 'sessionId',
                              'sessionIncarnationId', 'workspaceId'
                            ] = '{}'::JSONB
                            AND child_admission.admission_id = gc_try_parse_jsonb(child_run.payload_json)
                              #>> '{childAdmission,admissionId}'
                            AND child_admission.session_incarnation_id = gc_try_parse_jsonb(child_run.payload_json)
                              #>> '{childAdmission,sessionIncarnationId}'
                            AND child_admission.workspace_id = gc_try_parse_jsonb(child_run.payload_json)
                              #>> '{childAdmission,workspaceId}'
                            AND child_admission.session_id = gc_try_parse_jsonb(child_run.payload_json)
                              #>> '{childAdmission,sessionId}'
                            AND jsonb_typeof(gc_try_parse_jsonb(child_run.payload_json)
                              #> '{childAdmission,aggregateRevision}') = 'number'
                            AND gc_try_parse_jsonb(child_run.payload_json)
                              #>> '{childAdmission,aggregateRevision}' ~ '^[1-9][0-9]*$'
                            AND child_admission.aggregate_revision = (gc_try_parse_jsonb(child_run.payload_json)
                              #>> '{childAdmission,aggregateRevision}')::BIGINT
                            AND child_admission.aggregate_revision >= OLD.aggregate_revision
                            AND jsonb_typeof(gc_try_parse_jsonb(child_run.payload_json)
                              #> '{childAdmission,controllerGeneration}') = 'number'
                            AND gc_try_parse_jsonb(child_run.payload_json)
                              #>> '{childAdmission,controllerGeneration}' ~ '^[1-9][0-9]*$'
                            AND child_admission.controller_generation = (gc_try_parse_jsonb(child_run.payload_json)
                              #>> '{childAdmission,controllerGeneration}')::BIGINT
                            AND child_admission.actor_kind = gc_try_parse_jsonb(child_run.payload_json)
                              #>> '{childAdmission,actorKind}'
                            AND child_admission.actor_id = gc_try_parse_jsonb(child_run.payload_json)
                              #>> '{childAdmission,actorId}'
                            AND child_admission.operation = gc_try_parse_jsonb(child_run.payload_json)
                              #>> '{childAdmission,operation}'
                            AND child_admission.material_sha256 = gc_try_parse_jsonb(child_run.payload_json)
                              #>> '{childAdmission,materialSha256}'
                            AND jsonb_typeof(gc_try_parse_jsonb(child_run.payload_json)
                              -> 'postCommitEligibility') = 'object'
                            AND (gc_try_parse_jsonb(child_run.payload_json) -> 'postCommitEligibility') ?& ARRAY[
                              'autonomyEnabledAtParentSettlement', 'evalIntegrityTurn', 'humanSession', 'version'
                            ]
                            AND (gc_try_parse_jsonb(child_run.payload_json) -> 'postCommitEligibility') - ARRAY[
                              'autonomyEnabledAtParentSettlement', 'evalIntegrityTurn', 'humanSession', 'version'
                            ] = '{}'::JSONB
                            AND jsonb_typeof(gc_try_parse_jsonb(child_run.payload_json)
                              #> '{postCommitEligibility,version}') = 'number'
                            AND gc_try_parse_jsonb(child_run.payload_json)
                              #>> '{postCommitEligibility,version}' = '1'
                            AND jsonb_typeof(gc_try_parse_jsonb(child_run.payload_json)
                              #> '{postCommitEligibility,autonomyEnabledAtParentSettlement}') = 'boolean'
                            AND jsonb_typeof(gc_try_parse_jsonb(child_run.payload_json)
                              #> '{postCommitEligibility,evalIntegrityTurn}') = 'boolean'
                            AND jsonb_typeof(gc_try_parse_jsonb(child_run.payload_json)
                              #> '{postCommitEligibility,humanSession}') = 'boolean'
                            AND child_admission.admission_kind = 'synchronous'
                            AND child_admission.turn_id IS NULL
                            AND child_admission.session_incarnation_id = OLD.session_incarnation_id
                            AND child_admission.workspace_id = OLD.workspace_id
                            AND child_admission.session_id = OLD.session_id
                            AND child_admission.controller_generation = OLD.controller_generation
                            AND child_admission.actor_kind = OLD.actor_kind
                            AND child_admission.actor_id = OLD.actor_id
                            AND child_admission.operation = 'chat_post_commit_child'
                            AND child_admission.material_sha256 = encode(sha256(convert_to(
                              '{"childRunId":' || to_jsonb(child_run.run_id)::TEXT
                              || ',"effect":' || to_jsonb(gc_try_parse_jsonb(child_run.payload_json)
                                ->> 'effect')::TEXT
                              || ',"operation":"chat_post_commit_child"'
                              || ',"parentRunId":' || to_jsonb(run.run_id)::TEXT
                              || ',"postCommitEligibility":{"autonomyEnabledAtParentSettlement":'
                              || (gc_try_parse_jsonb(child_run.payload_json)
                                #> '{postCommitEligibility,autonomyEnabledAtParentSettlement}')::TEXT
                              || ',"evalIntegrityTurn":' || (gc_try_parse_jsonb(child_run.payload_json)
                                #> '{postCommitEligibility,evalIntegrityTurn}')::TEXT
                              || ',"humanSession":' || (gc_try_parse_jsonb(child_run.payload_json)
                                #> '{postCommitEligibility,humanSession}')::TEXT
                              || ',"version":1}'
                              || ',"postCommitGenerationId":' || to_jsonb(gc_try_parse_jsonb(run.metadata_json)
                                #>> '{chatTurnAdmissionHandoff,postCommitGenerationId}')::TEXT
                              || ',"sessionId":' || to_jsonb(OLD.session_id)::TEXT
                              || ',"sessionIncarnationId":' || to_jsonb(OLD.session_incarnation_id)::TEXT
                              || ',"sourceTurnId":' || to_jsonb(OLD.turn_id)::TEXT
                              || ',"version":1'
                              || ',"workspaceId":' || to_jsonb(OLD.workspace_id)::TEXT || '}',
                              'UTF8'
                            )), 'hex')
                        )
                      )
                      AND NOT EXISTS (
                        SELECT 1
                        FROM durable_runs omitted_child
                        WHERE omitted_child.workflow_key = 'chat.post_commit.effect'
                          AND gc_try_parse_jsonb(omitted_child.payload_json) ->> 'version'
                            = 'chat.post_commit.effect.v2'
                          AND gc_try_parse_jsonb(omitted_child.payload_json) ->> 'parentRunId' = run.run_id
                          AND gc_try_parse_jsonb(omitted_child.payload_json) ->> 'postCommitGenerationId'
                            = gc_try_parse_jsonb(run.metadata_json)
                              #>> '{chatTurnAdmissionHandoff,postCommitGenerationId}'
                          AND NOT EXISTS (
                            SELECT 1
                            FROM jsonb_array_elements(gc_try_parse_jsonb(run.metadata_json)
                              #> '{chatTurnAdmissionHandoff,childRunIds}') listed_child(value)
                            WHERE listed_child.value #>> '{}' = omitted_child.run_id
                          )
                      )
                  ))
                OR (OLD.admission_kind = 'synchronous'
                  AND NEW.terminal_authority_kind = 'post_commit_child_stage'
                  AND NEW.terminal_actor_id = 'system:chat-post-commit-stage'
                  AND NEW.terminal_correlation_id = NEW.terminal_durable_run_id
                  AND EXISTS (
                    SELECT 1 FROM durable_runs run
                    WHERE run.run_id = NEW.terminal_durable_run_id
                      AND run.workflow_key = 'chat.post_commit.effect' AND run.status = 'running'
                      AND run.lease_owner_id = NEW.terminal_durable_lease_owner_id
                      AND run.attempt_count = NEW.terminal_durable_attempt_count
                      AND run.version = NEW.terminal_durable_run_version
                      AND gc_try_parse_timestamptz(run.lease_expires_at) > clock_timestamp()
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'version' = 'chat.post_commit.effect.v2'
                      AND jsonb_typeof(gc_try_parse_jsonb(run.payload_json) -> 'effect') = 'string'
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'effect' IN (
                        'commitments', 'background_review', 'memory_maintenance'
                      )
                      AND jsonb_typeof(gc_try_parse_jsonb(run.payload_json) -> 'traceStatus') = 'string'
                      AND length(gc_try_parse_jsonb(run.payload_json) ->> 'traceStatus') > 0
                      AND jsonb_typeof(gc_try_parse_jsonb(run.payload_json) -> 'childAdmission') = 'object'
                      AND (gc_try_parse_jsonb(run.payload_json) -> 'childAdmission') ?& ARRAY[
                        'actorId', 'actorKind', 'admissionId', 'aggregateRevision',
                        'controllerGeneration', 'materialSha256', 'operation', 'sessionId',
                        'sessionIncarnationId', 'workspaceId'
                      ]
                      AND (gc_try_parse_jsonb(run.payload_json) -> 'childAdmission') - ARRAY[
                        'actorId', 'actorKind', 'admissionId', 'aggregateRevision',
                        'controllerGeneration', 'materialSha256', 'operation', 'sessionId',
                        'sessionIncarnationId', 'workspaceId'
                      ] = '{}'::JSONB
                      AND gc_try_parse_jsonb(run.payload_json) #>> '{childAdmission,admissionId}'
                        = OLD.admission_id
                      AND gc_try_parse_jsonb(run.payload_json) #>> '{childAdmission,sessionIncarnationId}'
                        = OLD.session_incarnation_id
                      AND gc_try_parse_jsonb(run.payload_json) #>> '{childAdmission,workspaceId}'
                        = OLD.workspace_id
                      AND gc_try_parse_jsonb(run.payload_json) #>> '{childAdmission,sessionId}' = OLD.session_id
                      AND jsonb_typeof(gc_try_parse_jsonb(run.payload_json)
                        #> '{childAdmission,aggregateRevision}') = 'number'
                      AND gc_try_parse_jsonb(run.payload_json)
                        #>> '{childAdmission,aggregateRevision}' ~ '^[1-9][0-9]*$'
                      AND (gc_try_parse_jsonb(run.payload_json)
                        #>> '{childAdmission,aggregateRevision}')::BIGINT = OLD.aggregate_revision
                      AND jsonb_typeof(gc_try_parse_jsonb(run.payload_json)
                        #> '{childAdmission,controllerGeneration}') = 'number'
                      AND gc_try_parse_jsonb(run.payload_json)
                        #>> '{childAdmission,controllerGeneration}' ~ '^[1-9][0-9]*$'
                      AND (gc_try_parse_jsonb(run.payload_json)
                        #>> '{childAdmission,controllerGeneration}')::BIGINT = OLD.controller_generation
                      AND gc_try_parse_jsonb(run.payload_json) #>> '{childAdmission,actorKind}' = OLD.actor_kind
                      AND gc_try_parse_jsonb(run.payload_json) #>> '{childAdmission,actorId}' = OLD.actor_id
                      AND gc_try_parse_jsonb(run.payload_json) #>> '{childAdmission,operation}' = OLD.operation
                      AND gc_try_parse_jsonb(run.payload_json) #>> '{childAdmission,materialSha256}'
                        = OLD.material_sha256
                      AND gc_try_parse_jsonb(run.payload_json) -> 'childAdmission'
                        = gc_try_parse_jsonb(run.metadata_json) -> 'childAdmission'
                      AND gc_try_parse_jsonb(run.payload_json) -> 'postCommitEligibility'
                        = gc_try_parse_jsonb(run.metadata_json) -> 'postCommitEligibility'
                      AND jsonb_typeof(gc_try_parse_jsonb(run.payload_json)
                        -> 'postCommitEligibility') = 'object'
                      AND (gc_try_parse_jsonb(run.payload_json) -> 'postCommitEligibility') ?& ARRAY[
                        'autonomyEnabledAtParentSettlement', 'evalIntegrityTurn', 'humanSession', 'version'
                      ]
                      AND (gc_try_parse_jsonb(run.payload_json) -> 'postCommitEligibility') - ARRAY[
                        'autonomyEnabledAtParentSettlement', 'evalIntegrityTurn', 'humanSession', 'version'
                      ] = '{}'::JSONB
                      AND jsonb_typeof(gc_try_parse_jsonb(run.payload_json)
                        #> '{postCommitEligibility,version}') = 'number'
                      AND gc_try_parse_jsonb(run.payload_json) #>> '{postCommitEligibility,version}' = '1'
                      AND jsonb_typeof(gc_try_parse_jsonb(run.payload_json)
                        #> '{postCommitEligibility,autonomyEnabledAtParentSettlement}') = 'boolean'
                      AND jsonb_typeof(gc_try_parse_jsonb(run.payload_json)
                        #> '{postCommitEligibility,evalIntegrityTurn}') = 'boolean'
                      AND jsonb_typeof(gc_try_parse_jsonb(run.payload_json)
                        #> '{postCommitEligibility,humanSession}') = 'boolean'
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'parentRunId'
                        = gc_try_parse_jsonb(run.metadata_json) ->> 'parentRunId'
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'postCommitGenerationId'
                        = gc_try_parse_jsonb(run.metadata_json) ->> 'postCommitGenerationId'
                      AND gc_try_parse_jsonb(run.payload_json) ->> 'effect'
                        = gc_try_parse_jsonb(run.metadata_json) ->> 'effect'
                      AND gc_try_parse_jsonb(run.metadata_json) ->> 'workspaceId' = OLD.workspace_id
                      AND gc_try_parse_jsonb(run.metadata_json) ->> 'sessionId' = OLD.session_id
                      AND jsonb_typeof(gc_try_parse_jsonb(run.metadata_json) -> 'turnId') = 'string'
                      AND length(gc_try_parse_jsonb(run.metadata_json) ->> 'turnId') > 0
                      AND OLD.material_sha256 = encode(sha256(convert_to(
                        '{"childRunId":' || to_jsonb(run.run_id)::TEXT
                        || ',"effect":' || to_jsonb(gc_try_parse_jsonb(run.payload_json) ->> 'effect')::TEXT
                        || ',"operation":"chat_post_commit_child"'
                        || ',"parentRunId":' || to_jsonb(gc_try_parse_jsonb(run.payload_json)
                          ->> 'parentRunId')::TEXT
                        || ',"postCommitEligibility":{"autonomyEnabledAtParentSettlement":'
                        || (gc_try_parse_jsonb(run.payload_json)
                          #> '{postCommitEligibility,autonomyEnabledAtParentSettlement}')::TEXT
                        || ',"evalIntegrityTurn":' || (gc_try_parse_jsonb(run.payload_json)
                          #> '{postCommitEligibility,evalIntegrityTurn}')::TEXT
                        || ',"humanSession":' || (gc_try_parse_jsonb(run.payload_json)
                          #> '{postCommitEligibility,humanSession}')::TEXT
                        || ',"version":1}'
                        || ',"postCommitGenerationId":' || to_jsonb(gc_try_parse_jsonb(run.payload_json)
                          ->> 'postCommitGenerationId')::TEXT
                        || ',"sessionId":' || to_jsonb(OLD.session_id)::TEXT
                        || ',"sessionIncarnationId":' || to_jsonb(OLD.session_incarnation_id)::TEXT
                        || ',"sourceTurnId":' || to_jsonb(gc_try_parse_jsonb(run.metadata_json)
                          ->> 'turnId')::TEXT
                        || ',"version":1'
                        || ',"workspaceId":' || to_jsonb(OLD.workspace_id)::TEXT || '}',
                        'UTF8'
                      )), 'hex')
                      AND ((NEW.status = 'completed' AND (
                        (gc_try_parse_jsonb(run.payload_json) ->> 'effect' = 'commitments'
                          AND NEW.terminal_idempotency_key = 'chat-post-commit-child-stage:v2:'
                            || run.run_id || ':commitments_write:allowed')
                        OR (gc_try_parse_jsonb(run.payload_json) ->> 'effect' = 'background_review'
                          AND NEW.terminal_idempotency_key = 'chat-post-commit-child-stage:v2:'
                            || run.run_id || ':background_evidence:allowed')
                        OR (gc_try_parse_jsonb(run.payload_json) ->> 'effect' = 'memory_maintenance'
                          AND NEW.terminal_idempotency_key = 'chat-post-commit-child-stage:v2:'
                            || run.run_id || ':memory_maintenance_evaluation:allowed')
                      )) OR (NEW.status = 'cancelled' AND (
                        (gc_try_parse_jsonb(run.payload_json) ->> 'effect' = 'commitments'
                          AND NEW.terminal_idempotency_key = 'chat-post-commit-child-stage:v2:'
                            || run.run_id || ':commitments_write:late_blocked')
                        OR (gc_try_parse_jsonb(run.payload_json) ->> 'effect' = 'background_review'
                          AND NEW.terminal_idempotency_key IN (
                            'chat-post-commit-child-stage:v2:' || run.run_id || ':background_counter:late_blocked',
                            'chat-post-commit-child-stage:v2:' || run.run_id || ':background_evidence:late_blocked'
                          ))
                        OR (gc_try_parse_jsonb(run.payload_json) ->> 'effect' = 'memory_maintenance'
                          AND NEW.terminal_idempotency_key = 'chat-post-commit-child-stage:v2:'
                            || run.run_id || ':memory_maintenance_evaluation:late_blocked')
                      )))
                  ))
                OR (NEW.terminal_authority_kind = 'lifecycle_delete'
                  AND NEW.status = 'cancelled'
                  AND EXISTS (
                    SELECT 1 FROM chat_session_lifecycle_intents intent
                    JOIN chat_session_meta meta ON meta.deletion_intent_id = intent.intent_id
                    WHERE intent.intent_id = NEW.terminal_lifecycle_intent_id
                      AND intent.intent_kind = 'delete'
                      AND intent.workspace_id = OLD.workspace_id AND intent.session_id = OLD.session_id
                      AND intent.session_incarnation_id = OLD.session_incarnation_id
                      AND meta.workspace_id = OLD.workspace_id AND meta.session_id = OLD.session_id
                      AND intent.actor_id = NEW.terminal_actor_id
                      AND intent.correlation_id = NEW.terminal_correlation_id
                      AND intent.created_at = NEW.closed_at
                      AND NEW.terminal_idempotency_key = 'lifecycle:delete:admission:' || OLD.admission_id
                  ))
                OR (NEW.terminal_authority_kind = 'authority_superseded'
                  AND NEW.status = 'cancelled'
                  AND NEW.terminal_actor_id = 'system:session-authority'
                  AND NEW.terminal_correlation_id = NEW.terminal_control_event_id
                  AND NEW.terminal_idempotency_key = 'admission:authority-superseded:'
                    || OLD.admission_id || ':' || NEW.terminal_control_event_id
                  AND EXISTS (
                    SELECT 1
                    FROM chat_session_meta meta
                    JOIN chat_session_control_grants control
                      ON control.session_id = meta.session_id AND control.is_current = 1
                    JOIN chat_session_control_events event_row
                      ON event_row.session_id = control.session_id
                      AND event_row.idempotency_key = control.transition_idempotency_key
                    WHERE meta.session_id = OLD.session_id
                      AND control.workspace_id = meta.workspace_id
                      AND event_row.event_id = NEW.terminal_control_event_id
                      AND event_row.next_generation = control.generation
                      AND (meta.workspace_id <> OLD.workspace_id
                        OR COALESCE(meta.lifecycle_intent_id, 'legacy-session-incarnation:' || meta.session_id)
                          <> OLD.session_incarnation_id
                        OR control.generation <> OLD.controller_generation
                        OR (OLD.actor_kind IN ('operator', 'system')
                          AND NOT (control.owner_kind = 'operator' AND control.lease_state = 'operator_active'))
                        OR (OLD.actor_kind = 'external_companion'
                          AND NOT (control.owner_kind = 'external_companion'
                            AND control.lease_state = 'external_live'
                            AND control.companion_session_id = OLD.actor_id)))
                  ))
              ))
          ) THEN
          RAISE EXCEPTION 'session mutation admission identity and material are immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_session_mutation_admissions_guard
        BEFORE INSERT OR UPDATE ON chat_session_mutation_admissions FOR EACH ROW
        EXECUTE FUNCTION gc_session_mutation_admission_guard();

      CREATE OR REPLACE FUNCTION gc_session_mutation_admission_event()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO chat_session_mutation_admission_events (
            event_id, admission_id, session_incarnation_id, workspace_id, session_id, turn_id,
            runtime_owner_id, runtime_lease_revision,
            event_sequence, event_type,
            admission_kind, aggregate_revision, controller_generation, actor_kind, actor_id,
            operation, material_sha256, idempotency_key, request_sha256, correlation_id,
            terminal_authority_kind, terminal_runtime_owner_id, terminal_runtime_lease_revision,
            terminal_durable_run_id, terminal_durable_lease_owner_id, terminal_durable_attempt_count,
            terminal_durable_run_version, terminal_durable_run_status, terminal_lifecycle_intent_id,
            terminal_control_event_id,
            created_at
          ) VALUES (
            NEW.admit_event_id, NEW.admission_id, NEW.session_incarnation_id,
            NEW.workspace_id, NEW.session_id, NEW.turn_id,
            NEW.runtime_owner_id, NEW.runtime_lease_revision, 1, 'admitted',
            NEW.admission_kind, NEW.aggregate_revision, NEW.controller_generation, NEW.actor_kind, NEW.actor_id,
            NEW.operation, NEW.material_sha256, NEW.idempotency_key, NEW.request_sha256,
            NEW.correlation_id,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            NEW.created_at
          );
        ELSIF NEW.status <> OLD.status THEN
          INSERT INTO chat_session_mutation_admission_events (
            event_id, admission_id, session_incarnation_id, workspace_id, session_id, turn_id,
            runtime_owner_id, runtime_lease_revision,
            event_sequence, event_type,
            admission_kind, aggregate_revision, controller_generation, actor_kind, actor_id,
            operation, material_sha256, idempotency_key, request_sha256, correlation_id,
            terminal_authority_kind, terminal_runtime_owner_id, terminal_runtime_lease_revision,
            terminal_durable_run_id, terminal_durable_lease_owner_id, terminal_durable_attempt_count,
            terminal_durable_run_version, terminal_durable_run_status, terminal_lifecycle_intent_id,
            terminal_control_event_id,
            created_at
          ) VALUES (
            NEW.terminal_event_id, NEW.admission_id, NEW.session_incarnation_id,
            NEW.workspace_id, NEW.session_id, NEW.turn_id,
            NEW.runtime_owner_id, NEW.runtime_lease_revision, 2, NEW.status,
            NEW.admission_kind, NEW.aggregate_revision, NEW.controller_generation, NEW.actor_kind,
            NEW.terminal_actor_id, NEW.operation, NEW.material_sha256, NEW.terminal_idempotency_key,
            NEW.request_sha256, NEW.terminal_correlation_id,
            NEW.terminal_authority_kind, NEW.terminal_runtime_owner_id, NEW.terminal_runtime_lease_revision,
            NEW.terminal_durable_run_id, NEW.terminal_durable_lease_owner_id, NEW.terminal_durable_attempt_count,
            NEW.terminal_durable_run_version, NEW.terminal_durable_run_status, NEW.terminal_lifecycle_intent_id,
            NEW.terminal_control_event_id,
            NEW.closed_at
          );
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_session_mutation_admissions_event
        AFTER INSERT OR UPDATE ON chat_session_mutation_admissions FOR EACH ROW
        EXECUTE FUNCTION gc_session_mutation_admission_event();
      CREATE TRIGGER trg_chat_session_mutation_admissions_no_delete
        BEFORE DELETE ON chat_session_mutation_admissions FOR EACH ROW
        EXECUTE FUNCTION gc_reject_session_lifecycle_immutable_mutation();
      CREATE TRIGGER trg_chat_session_mutation_admission_events_no_update
        BEFORE UPDATE ON chat_session_mutation_admission_events FOR EACH ROW
        EXECUTE FUNCTION gc_reject_session_lifecycle_immutable_mutation();
      CREATE TRIGGER trg_chat_session_mutation_admission_events_no_delete
        BEFORE DELETE ON chat_session_mutation_admission_events FOR EACH ROW
        EXECUTE FUNCTION gc_reject_session_lifecycle_immutable_mutation();

      CREATE OR REPLACE FUNCTION gc_chat_turn_session_incarnation_binding_guard()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.session_id, 411));
        IF NEW.admission_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM chat_session_mutation_admissions admission
          WHERE admission.admission_id = NEW.admission_id AND admission.status = 'active'
            AND admission.admission_kind = 'turn_write'
            AND admission.turn_id = NEW.turn_id
            AND admission.workspace_id = NEW.workspace_id AND admission.session_id = NEW.session_id
            AND admission.session_incarnation_id = NEW.session_incarnation_id
        ) THEN
          RAISE EXCEPTION 'chat turn session incarnation authority invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_turn_session_incarnation_bindings_insert_guard
        BEFORE INSERT ON chat_turn_session_incarnation_bindings FOR EACH ROW
        EXECUTE FUNCTION gc_chat_turn_session_incarnation_binding_guard();
      CREATE TRIGGER trg_chat_turn_session_incarnation_bindings_no_update
        BEFORE UPDATE ON chat_turn_session_incarnation_bindings FOR EACH ROW
        EXECUTE FUNCTION gc_reject_session_lifecycle_immutable_mutation();
      CREATE TRIGGER trg_chat_turn_session_incarnation_bindings_no_delete
        BEFORE DELETE ON chat_turn_session_incarnation_bindings FOR EACH ROW
        EXECUTE FUNCTION gc_reject_session_lifecycle_immutable_mutation();

      CREATE OR REPLACE FUNCTION gc_chat_turn_durable_admission_binding_guard()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.session_id, 411));
        IF NOT EXISTS (
          SELECT 1
          FROM chat_session_mutation_admissions admission
          JOIN chat_turn_session_incarnation_bindings binding
            ON binding.admission_id = admission.admission_id AND binding.turn_id = admission.turn_id
          JOIN durable_runs run ON run.run_id = NEW.durable_run_id
          WHERE admission.admission_id = NEW.admission_id
            AND admission.status = 'active' AND admission.admission_kind = 'turn_write'
            AND admission.runtime_lease_relinquished_at IS NULL
            AND gc_try_parse_timestamptz(admission.runtime_lease_expires_at) > clock_timestamp()
            AND admission.turn_id = NEW.turn_id
            AND admission.workspace_id = NEW.workspace_id AND admission.session_id = NEW.session_id
            AND admission.session_incarnation_id = NEW.session_incarnation_id
            AND binding.workspace_id = NEW.workspace_id AND binding.session_id = NEW.session_id
            AND binding.session_incarnation_id = NEW.session_incarnation_id
            AND run.workflow_key = 'chat.turn.execute'
            AND run.status IN ('queued', 'running', 'waiting', 'paused')
            AND jsonb_typeof(gc_try_parse_jsonb(run.payload_json)) = 'object'
            AND gc_try_parse_jsonb(run.payload_json) ->> 'version' = 'chat.turn.execute.v2'
            AND gc_try_parse_jsonb(run.payload_json) ->> 'admissionId' = admission.admission_id
            AND gc_try_parse_jsonb(run.payload_json) ->> 'sessionIncarnationId' = admission.session_incarnation_id
            AND gc_try_parse_jsonb(run.payload_json) ->> 'admissionMaterialSha256' = admission.material_sha256
            AND gc_try_parse_jsonb(run.payload_json) ->> 'workspaceId' = admission.workspace_id
            AND jsonb_typeof(gc_try_parse_jsonb(run.payload_json) -> 'admissionAggregateRevision') = 'number'
            AND gc_try_parse_jsonb(run.payload_json) ->> 'admissionAggregateRevision' ~ '^[1-9][0-9]*$'
            AND (gc_try_parse_jsonb(run.payload_json) ->> 'admissionAggregateRevision')::BIGINT
              = admission.aggregate_revision
            AND jsonb_typeof(gc_try_parse_jsonb(run.payload_json) -> 'admissionControllerGeneration') = 'number'
            AND gc_try_parse_jsonb(run.payload_json) ->> 'admissionControllerGeneration' ~ '^[1-9][0-9]*$'
            AND (gc_try_parse_jsonb(run.payload_json) ->> 'admissionControllerGeneration')::BIGINT
              = admission.controller_generation
            AND gc_try_parse_jsonb(run.payload_json) ->> 'sessionId' = admission.session_id
            AND gc_try_parse_jsonb(run.payload_json) ->> 'turnId' = admission.turn_id
        ) THEN
          RAISE EXCEPTION 'chat turn durable admission binding authority invariant violated'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_turn_mutation_admission_durable_bindings_insert_guard
        BEFORE INSERT ON chat_turn_mutation_admission_durable_bindings FOR EACH ROW
        EXECUTE FUNCTION gc_chat_turn_durable_admission_binding_guard();
      CREATE TRIGGER trg_chat_turn_mutation_admission_durable_bindings_no_update
        BEFORE UPDATE ON chat_turn_mutation_admission_durable_bindings FOR EACH ROW
        EXECUTE FUNCTION gc_reject_session_lifecycle_immutable_mutation();
      CREATE TRIGGER trg_chat_turn_mutation_admission_durable_bindings_no_delete
        BEFORE DELETE ON chat_turn_mutation_admission_durable_bindings FOR EACH ROW
        EXECUTE FUNCTION gc_reject_session_lifecycle_immutable_mutation();

      CREATE OR REPLACE FUNCTION gc_chat_turn_user_input_continuation_seal_guard()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.session_id, 411));
        IF abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.resolved_at) - clock_timestamp()))) > 1
          OR NOT EXISTS (
            SELECT 1
            FROM chat_session_mutation_admissions admission
            JOIN chat_turn_mutation_admission_durable_bindings durable_binding
              ON durable_binding.admission_id = admission.admission_id
            JOIN durable_runs run ON run.run_id = durable_binding.durable_run_id
            JOIN chat_turn_traces trace ON trace.turn_id = admission.turn_id
            WHERE admission.admission_id = NEW.admission_id
              AND admission.status = 'active' AND admission.admission_kind = 'turn_write'
              AND admission.session_incarnation_id = NEW.session_incarnation_id
              AND admission.workspace_id = NEW.workspace_id
              AND admission.session_id = NEW.session_id
              AND admission.turn_id = NEW.turn_id
              AND durable_binding.durable_run_id = NEW.durable_run_id
              AND run.workflow_key = 'chat.turn.execute' AND run.status = 'waiting'
              AND run.version = NEW.waiting_run_version
              AND trace.session_id = NEW.session_id AND trace.status = 'waiting_for_user_input'
              AND jsonb_typeof(gc_try_parse_jsonb(trace.pending_user_input_json)) = 'object'
              AND gc_try_parse_jsonb(trace.pending_user_input_json) ->> 'promptId' = NEW.prompt_id
              AND gc_try_parse_jsonb(trace.pending_user_input_json) ->> 'turnId' = NEW.turn_id
          ) THEN
          RAISE EXCEPTION 'chat turn user-input continuation seal authority invariant violated'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_turn_user_input_continuation_seals_insert_guard
        BEFORE INSERT ON chat_turn_user_input_continuation_seals FOR EACH ROW
        EXECUTE FUNCTION gc_chat_turn_user_input_continuation_seal_guard();
      CREATE TRIGGER trg_chat_turn_user_input_continuation_seals_no_update
        BEFORE UPDATE ON chat_turn_user_input_continuation_seals FOR EACH ROW
        EXECUTE FUNCTION gc_reject_session_lifecycle_immutable_mutation();
      CREATE TRIGGER trg_chat_turn_user_input_continuation_seals_no_delete
        BEFORE DELETE ON chat_turn_user_input_continuation_seals FOR EACH ROW
        EXECUTE FUNCTION gc_reject_session_lifecycle_immutable_mutation();

      CREATE OR REPLACE FUNCTION gc_chat_turn_capability_profile_binding_guard()
      RETURNS trigger AS $$
      DECLARE bound_session_id TEXT;
      BEGIN
        SELECT session_id INTO bound_session_id
        FROM chat_turn_session_incarnation_bindings WHERE turn_id = NEW.turn_id;
        IF bound_session_id IS NULL THEN
          RAISE EXCEPTION 'chat turn capability profile binding authority invariant violated'
            USING ERRCODE = '23514';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(bound_session_id, 411));
        IF NOT EXISTS (
          SELECT 1
          FROM chat_turn_session_incarnation_bindings binding
          JOIN chat_session_mutation_admissions admission
            ON admission.admission_id = binding.admission_id
          WHERE binding.turn_id = NEW.turn_id
            AND admission.status = 'active' AND admission.admission_kind = 'turn_write'
            AND admission.turn_id = NEW.turn_id
            AND admission.workspace_id = binding.workspace_id
            AND admission.session_id = binding.session_id
            AND admission.session_incarnation_id = binding.session_incarnation_id
        ) THEN
          RAISE EXCEPTION 'chat turn capability profile binding authority invariant violated'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_turn_capability_profile_incarnation_bindings_insert_guard
        BEFORE INSERT ON chat_turn_capability_profile_incarnation_bindings FOR EACH ROW
        EXECUTE FUNCTION gc_chat_turn_capability_profile_binding_guard();
      CREATE TRIGGER trg_chat_turn_capability_profile_incarnation_bindings_no_update
        BEFORE UPDATE ON chat_turn_capability_profile_incarnation_bindings FOR EACH ROW
        EXECUTE FUNCTION gc_reject_session_lifecycle_immutable_mutation();
      CREATE TRIGGER trg_chat_turn_capability_profile_incarnation_bindings_no_delete
        BEFORE DELETE ON chat_turn_capability_profile_incarnation_bindings FOR EACH ROW
        EXECUTE FUNCTION gc_reject_session_lifecycle_immutable_mutation();

      CREATE OR REPLACE FUNCTION gc_chat_turn_capability_profile_incarnation_guard()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.session_id, 411));
        IF NOT EXISTS (
          SELECT 1
          FROM chat_turn_capability_profile_incarnation_bindings profile_binding
          JOIN chat_turn_session_incarnation_bindings binding
            ON binding.turn_id = profile_binding.turn_id
          JOIN chat_session_mutation_admissions admission
            ON admission.admission_id = binding.admission_id
          WHERE binding.turn_id = NEW.turn_id
            AND profile_binding.profile_id = NEW.profile_id
            AND profile_binding.profile_hash = NEW.profile_hash
            AND profile_binding.created_at = NEW.created_at
            AND binding.workspace_id = NEW.workspace_id AND binding.session_id = NEW.session_id
            AND admission.status = 'active' AND admission.admission_kind = 'turn_write'
            AND admission.turn_id = NEW.turn_id
            AND admission.workspace_id = binding.workspace_id
            AND admission.session_id = binding.session_id
            AND admission.session_incarnation_id = binding.session_incarnation_id
        ) THEN
          RAISE EXCEPTION 'chat turn capability profile requires a frozen session incarnation'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_turn_capability_profiles_incarnation_insert_guard
        BEFORE INSERT ON chat_turn_capability_profiles FOR EACH ROW
        EXECUTE FUNCTION gc_chat_turn_capability_profile_incarnation_guard();

      CREATE OR REPLACE FUNCTION gc_chat_routed_context_snapshot_incarnation_guard()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.session_id, 411));
        IF NOT EXISTS (
          SELECT 1
          FROM chat_turn_capability_profiles profile
          JOIN chat_turn_capability_profile_incarnation_bindings profile_binding
            ON profile_binding.profile_id = profile.profile_id AND profile_binding.turn_id = profile.turn_id
          JOIN chat_turn_session_incarnation_bindings binding
            ON binding.turn_id = profile.turn_id
          JOIN chat_session_mutation_admissions admission
            ON admission.admission_id = binding.admission_id
          WHERE profile.profile_id = NEW.capability_profile_id
            AND profile.profile_hash = NEW.capability_profile_hash
            AND profile.turn_id = NEW.turn_id AND profile.session_id = NEW.session_id
            AND profile.workspace_id = NEW.workspace_id
            AND profile_binding.profile_hash = NEW.capability_profile_hash
            AND binding.session_id = NEW.session_id AND binding.workspace_id = NEW.workspace_id
            AND admission.status = 'active' AND admission.admission_kind = 'turn_write'
            AND admission.turn_id = NEW.turn_id
            AND admission.workspace_id = binding.workspace_id
            AND admission.session_id = binding.session_id
            AND admission.session_incarnation_id = binding.session_incarnation_id
        ) THEN
          RAISE EXCEPTION 'chat routed context snapshot requires an exact incarnation-bound profile'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_routed_context_snapshots_incarnation_insert_guard
        BEFORE INSERT ON chat_routed_context_snapshots FOR EACH ROW
        EXECUTE FUNCTION gc_chat_routed_context_snapshot_incarnation_guard();

      CREATE OR REPLACE FUNCTION gc_auth_revoke_operation_guard()
      RETURNS trigger AS $$
      BEGIN
        IF abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.occurred_at) - clock_timestamp()))) > 1
          OR EXISTS (SELECT 1 FROM chat_session_control_auth_revoke_receipts receipt
            WHERE receipt.idempotency_key = NEW.idempotency_key)
          OR EXISTS (SELECT 1 FROM chat_session_control_events event_row
            WHERE event_row.request_sha256 = NEW.request_sha256 OR event_row.idempotency_key = NEW.idempotency_key) THEN
          RAISE EXCEPTION 'session control auth revoke operation invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_session_control_auth_revoke_operations_guard
        BEFORE INSERT ON chat_session_control_auth_revoke_operations FOR EACH ROW
        EXECUTE FUNCTION gc_auth_revoke_operation_guard();
      CREATE TRIGGER trg_chat_session_control_auth_revoke_operations_no_update
        BEFORE UPDATE ON chat_session_control_auth_revoke_operations FOR EACH ROW
        EXECUTE FUNCTION gc_reject_session_lifecycle_immutable_mutation();
      CREATE TRIGGER trg_chat_session_control_auth_revoke_operations_no_delete
        BEFORE DELETE ON chat_session_control_auth_revoke_operations FOR EACH ROW
        EXECUTE FUNCTION gc_reject_session_lifecycle_immutable_mutation();

      CREATE OR REPLACE FUNCTION gc_auth_revoke_target_guard()
      RETURNS trigger AS $$
      DECLARE operation chat_session_control_auth_revoke_operations%ROWTYPE;
      DECLARE prior_events BIGINT;
      DECLARE prior_targets BIGINT;
      BEGIN
        SELECT * INTO STRICT operation FROM chat_session_control_auth_revoke_operations
          WHERE idempotency_key = NEW.operation_idempotency_key FOR UPDATE;
        IF EXISTS (SELECT 1 FROM chat_session_control_auth_revoke_receipts receipt
          WHERE receipt.idempotency_key = operation.idempotency_key) OR NEW.target_index >= operation.target_count THEN
          RAISE EXCEPTION 'session control auth revoke target invariant violated' USING ERRCODE = '23514';
        END IF;
        SELECT COUNT(*) INTO prior_events FROM chat_session_control_events WHERE session_id = NEW.session_id;
        SELECT COUNT(*) INTO prior_targets FROM chat_session_control_auth_revoke_operation_targets
          WHERE operation_idempotency_key = NEW.operation_idempotency_key AND session_id = NEW.session_id;
        IF NEW.event_sequence <> prior_events + prior_targets + 1 OR NOT (
          (NEW.target_kind = 'pending_request' AND NEW.event_reason_code IN ('mutation_denied', 'request_expired')
            AND EXISTS (
              SELECT 1 FROM chat_session_control_requests request_row
              JOIN chat_session_control_grants control
                ON control.session_id = request_row.session_id AND control.is_current = 1
              WHERE request_row.request_id = NEW.request_id AND request_row.status = 'pending'
                AND request_row.workspace_id = NEW.workspace_id AND request_row.session_id = NEW.session_id
                AND control.workspace_id = NEW.workspace_id AND control.generation = NEW.generation
                AND control.control_revision = NEW.control_revision AND control.owner_kind = NEW.owner_kind
                AND control.lease_state = NEW.lease_state
                AND ((operation.binding_kind = 'companion_session' AND request_row.companion_session_id = operation.binding_id)
                  OR (operation.binding_kind = 'device_grant' AND request_row.device_grant_id = operation.binding_id))
                AND ((gc_try_parse_timestamptz(request_row.expires_at) <= gc_try_parse_timestamptz(operation.occurred_at)
                      AND NEW.event_reason_code = 'request_expired')
                  OR (gc_try_parse_timestamptz(request_row.expires_at) > gc_try_parse_timestamptz(operation.occurred_at)
                      AND NEW.event_reason_code = 'mutation_denied'))
            ))
          OR (NEW.target_kind = 'current_grant' AND NEW.event_reason_code = 'auth_revoked'
            AND EXISTS (
              SELECT 1 FROM chat_session_control_grants control
              WHERE control.session_id = NEW.session_id AND control.workspace_id = NEW.workspace_id
                AND control.generation = NEW.generation AND control.control_revision = NEW.control_revision
                AND control.is_current = 1 AND control.owner_kind = 'external_companion'
                AND control.lease_state = NEW.lease_state AND control.request_id = NEW.request_id
                AND ((operation.binding_kind = 'companion_session' AND control.companion_session_id = operation.binding_id)
                  OR (operation.binding_kind = 'device_grant' AND control.device_grant_id = operation.binding_id))
            ))
        ) THEN
          RAISE EXCEPTION 'session control auth revoke target invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_session_control_auth_revoke_targets_guard
        BEFORE INSERT ON chat_session_control_auth_revoke_operation_targets FOR EACH ROW
        EXECUTE FUNCTION gc_auth_revoke_target_guard();
      CREATE TRIGGER trg_chat_session_control_auth_revoke_targets_no_update
        BEFORE UPDATE ON chat_session_control_auth_revoke_operation_targets FOR EACH ROW
        EXECUTE FUNCTION gc_reject_session_lifecycle_immutable_mutation();
      CREATE TRIGGER trg_chat_session_control_auth_revoke_targets_no_delete
        BEFORE DELETE ON chat_session_control_auth_revoke_operation_targets FOR EACH ROW
        EXECUTE FUNCTION gc_reject_session_lifecycle_immutable_mutation();

      CREATE OR REPLACE FUNCTION gc_session_control_request_transition_guard()
      RETURNS trigger AS $$
      DECLARE auth_bypass BOOLEAN := FALSE;
      BEGIN
        SELECT EXISTS (
          SELECT 1 FROM chat_session_control_auth_revoke_operation_targets target
          JOIN chat_session_control_auth_revoke_operations operation
            ON operation.idempotency_key = target.operation_idempotency_key
          WHERE target.target_kind = 'pending_request' AND target.request_id = OLD.request_id
            AND target.workspace_id = OLD.workspace_id AND target.session_id = OLD.session_id
            AND operation.occurred_at = NEW.decided_at
            AND NOT EXISTS (SELECT 1 FROM chat_session_control_auth_revoke_receipts receipt
              WHERE receipt.idempotency_key = operation.idempotency_key)
        ) INTO auth_bypass;
        IF OLD.status <> 'pending'
          OR NEW.request_id <> OLD.request_id OR NEW.workspace_id <> OLD.workspace_id
          OR NEW.session_id <> OLD.session_id OR NEW.companion_session_id <> OLD.companion_session_id
          OR NEW.device_grant_id <> OLD.device_grant_id OR NEW.client_instance_id <> OLD.client_instance_id
          OR NEW.principal_purpose <> OLD.principal_purpose OR NEW.token_sha256 <> OLD.token_sha256
          OR NEW.requested_capabilities_json <> OLD.requested_capabilities_json
          OR NEW.requested_capabilities_sha256 <> OLD.requested_capabilities_sha256
          OR NEW.requested_generation <> OLD.requested_generation OR NEW.idempotency_key <> OLD.idempotency_key
          OR NEW.request_sha256 <> OLD.request_sha256 OR NEW.expires_at <> OLD.expires_at
          OR NEW.created_at <> OLD.created_at OR NEW.status = 'pending'
          OR (abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.decided_at) - clock_timestamp()))) > 1
            AND NOT auth_bypass) THEN
          RAISE EXCEPTION 'session control request transition invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_session_control_grant_insert_guard()
      RETURNS trigger AS $$
      DECLARE prior_generation BIGINT;
      DECLARE prior_workspace TEXT;
      DECLARE database_now TIMESTAMPTZ := clock_timestamp();
      DECLARE auth_bypass BOOLEAN := FALSE;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.session_id, 411));
        SELECT MAX(generation), MIN(workspace_id) INTO prior_generation, prior_workspace
        FROM chat_session_control_grants WHERE session_id = NEW.session_id;
        SELECT EXISTS (
          SELECT 1 FROM chat_session_control_auth_revoke_operation_targets target
          JOIN chat_session_control_auth_revoke_operations operation
            ON operation.idempotency_key = target.operation_idempotency_key
          WHERE target.target_kind = 'current_grant'
            AND target.workspace_id = NEW.workspace_id AND target.session_id = NEW.session_id
            AND target.generation + 1 = NEW.generation
            AND target.event_idempotency_key = NEW.transition_idempotency_key
            AND operation.request_sha256 = NEW.transition_request_sha256
            AND operation.occurred_at = NEW.created_at AND operation.occurred_at = NEW.updated_at
            AND NEW.owner_kind = 'operator' AND NEW.lease_state = 'operator_active'
            AND NOT EXISTS (SELECT 1 FROM chat_session_control_auth_revoke_receipts receipt
              WHERE receipt.idempotency_key = operation.idempotency_key)
        ) INTO auth_bypass;
        IF NEW.is_current <> 1 OR (prior_workspace IS NOT NULL AND prior_workspace <> NEW.workspace_id)
          OR (prior_generation IS NULL AND NEW.generation <> 1)
          OR (prior_generation IS NOT NULL AND NEW.generation <> prior_generation + 1)
          OR ((abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.created_at) - database_now))) > 1
            OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.updated_at) - database_now))) > 1)
            AND NOT auth_bypass) THEN
          RAISE EXCEPTION 'session control generation, workspace, or database-clock invariant violated' USING ERRCODE = '23514';
        END IF;
        IF NEW.owner_kind = 'external_companion' AND NOT EXISTS (
          SELECT 1 FROM chat_session_control_requests request_row
          JOIN chat_session_control_tokens token_row ON token_row.token_sha256 = NEW.token_sha256
          WHERE request_row.request_id = NEW.request_id
            AND request_row.workspace_id = NEW.workspace_id AND request_row.session_id = NEW.session_id
            AND request_row.companion_session_id = NEW.companion_session_id
            AND request_row.device_grant_id = NEW.device_grant_id
            AND request_row.client_instance_id = NEW.client_instance_id
            AND request_row.principal_purpose = NEW.principal_purpose
            AND request_row.requested_capabilities_json = NEW.requested_capabilities_json
            AND request_row.requested_capabilities_sha256 = NEW.requested_capabilities_sha256
            AND request_row.status = 'activated' AND request_row.decision_reason_code = 'handoff'
            AND request_row.activated_generation = request_row.requested_generation + 1
            AND request_row.activated_generation <= NEW.generation
            AND token_row.workspace_id = NEW.workspace_id AND token_row.session_id = NEW.session_id
            AND ((NEW.generation = request_row.activated_generation AND NEW.token_sha256 = request_row.token_sha256)
              OR (NEW.generation > request_row.activated_generation AND EXISTS (
                SELECT 1 FROM chat_session_control_grants prior
                WHERE prior.workspace_id = NEW.workspace_id AND prior.session_id = NEW.session_id
                  AND prior.generation = NEW.generation - 1 AND prior.owner_kind = 'external_companion'
                  AND prior.request_id = NEW.request_id
                  AND prior.companion_session_id = NEW.companion_session_id
                  AND prior.device_grant_id = NEW.device_grant_id
                  AND prior.client_instance_id = NEW.client_instance_id
                  AND prior.principal_purpose = NEW.principal_purpose
                  AND prior.requested_capabilities_json = NEW.requested_capabilities_json
                  AND prior.requested_capabilities_sha256 = NEW.requested_capabilities_sha256
                  AND prior.effective_capabilities_json = NEW.effective_capabilities_json
                  AND prior.effective_capabilities_sha256 = NEW.effective_capabilities_sha256)))
            AND ((NEW.requested_capabilities_json = '["send"]' AND NEW.effective_capabilities_json = '["send"]')
              OR (NEW.requested_capabilities_json = '["send","read"]'
                AND NEW.effective_capabilities_json IN ('["send"]', '["send","read"]')))
        ) THEN
          RAISE EXCEPTION 'session control external request binding invariant violated' USING ERRCODE = '23514';
        END IF;
        IF NEW.owner_kind = 'external_companion' AND NOT EXISTS (
          SELECT 1 FROM companion_sessions companion_session
          JOIN auth_device_grants device_grant ON device_grant.grant_id = companion_session.grant_id
          JOIN auth_device_requests device_request ON device_request.request_id = device_grant.request_id
          WHERE companion_session.session_id = NEW.companion_session_id
            AND companion_session.grant_id = NEW.device_grant_id
            AND companion_session.principal_purpose = NEW.principal_purpose
            AND device_grant.principal_purpose = NEW.principal_purpose
            AND device_request.principal_purpose = NEW.principal_purpose
            AND NEW.principal_purpose = 'session_control_client'
            AND companion_session.revoked_at IS NULL AND device_grant.revoked_at IS NULL
            AND gc_try_parse_timestamptz(companion_session.refresh_token_expires_at) > database_now
            AND (device_grant.expires_at IS NULL OR gc_try_parse_timestamptz(device_grant.expires_at) > database_now)
        ) THEN
          RAISE EXCEPTION 'session control external auth binding invariant violated' USING ERRCODE = '23514';
        END IF;
        IF NEW.owner_kind = 'external_companion' AND (
          abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.token_expires_at) - database_now)) - 900) > 1
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.lease_expires_at) - database_now)) - 60) > 1
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.reconnect_expires_at) - database_now)) - 300) > 1
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.last_heartbeat_at) - database_now))) > 1
        ) THEN
          RAISE EXCEPTION 'session control external database-clock invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_session_control_grant_update_guard()
      RETURNS trigger AS $$
      DECLARE database_now TIMESTAMPTZ := clock_timestamp();
      DECLARE valid_transition BOOLEAN := FALSE;
      DECLARE auth_bypass BOOLEAN := FALSE;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.session_id, 411));
        SELECT EXISTS (
          SELECT 1 FROM chat_session_control_auth_revoke_operation_targets target
          JOIN chat_session_control_auth_revoke_operations operation
            ON operation.idempotency_key = target.operation_idempotency_key
          WHERE target.target_kind = 'current_grant'
            AND target.workspace_id = OLD.workspace_id AND target.session_id = OLD.session_id
            AND target.generation = OLD.generation AND target.control_revision = OLD.control_revision
            AND operation.occurred_at = NEW.updated_at AND NEW.terminal_at = operation.occurred_at
            AND NOT EXISTS (SELECT 1 FROM chat_session_control_auth_revoke_receipts receipt
              WHERE receipt.idempotency_key = operation.idempotency_key)
        ) INTO auth_bypass;
        IF OLD.is_current <> 1 OR OLD.terminal_at IS NOT NULL
          OR NEW.workspace_id <> OLD.workspace_id OR NEW.session_id <> OLD.session_id
          OR NEW.generation <> OLD.generation OR NEW.owner_kind <> OLD.owner_kind
          OR NEW.request_id IS DISTINCT FROM OLD.request_id
          OR NEW.companion_session_id IS DISTINCT FROM OLD.companion_session_id
          OR NEW.device_grant_id IS DISTINCT FROM OLD.device_grant_id
          OR NEW.client_instance_id IS DISTINCT FROM OLD.client_instance_id
          OR NEW.principal_purpose IS DISTINCT FROM OLD.principal_purpose
          OR NEW.requested_capabilities_json <> OLD.requested_capabilities_json
          OR NEW.requested_capabilities_sha256 <> OLD.requested_capabilities_sha256
          OR NEW.effective_capabilities_json <> OLD.effective_capabilities_json
          OR NEW.effective_capabilities_sha256 <> OLD.effective_capabilities_sha256
          OR NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256
          OR NEW.token_expires_at IS DISTINCT FROM OLD.token_expires_at
          OR NEW.transition_idempotency_key <> OLD.transition_idempotency_key
          OR NEW.transition_request_sha256 <> OLD.transition_request_sha256
          OR NEW.created_at <> OLD.created_at OR NEW.control_revision <> OLD.control_revision + 1
          OR NEW.updated_at < OLD.updated_at
          OR (abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.updated_at) - database_now))) > 1
            AND NOT auth_bypass) THEN
          RAISE EXCEPTION 'session control current generation transition invariant violated' USING ERRCODE = '23514';
        END IF;
        valid_transition := OLD.owner_kind = 'external_companion' AND OLD.lease_state = 'external_live'
          AND NEW.is_current = 1 AND NEW.lease_state = 'external_live' AND NEW.terminal_at IS NULL
          AND gc_try_parse_timestamptz(NEW.last_heartbeat_at) >= gc_try_parse_timestamptz(OLD.last_heartbeat_at)
          AND abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.last_heartbeat_at) - database_now))) <= 1
          AND abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.lease_expires_at) - database_now)) - 60) <= 1
          AND abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.reconnect_expires_at) - database_now)) - 300) <= 1;
        valid_transition := valid_transition OR (OLD.owner_kind = 'external_companion' AND OLD.lease_state = 'external_live'
          AND NEW.is_current = 1 AND NEW.lease_state = 'external_stale' AND NEW.terminal_at IS NULL
          AND NEW.last_heartbeat_at = OLD.last_heartbeat_at AND NEW.lease_expires_at = OLD.lease_expires_at
          AND NEW.reconnect_expires_at = OLD.reconnect_expires_at);
        valid_transition := valid_transition OR (NEW.is_current = 0
          AND NEW.lease_state IN ('released', 'revoked', 'superseded', 'deleted')
          AND NEW.terminal_at = NEW.updated_at
          AND NEW.last_heartbeat_at IS NOT DISTINCT FROM OLD.last_heartbeat_at
          AND NEW.lease_expires_at IS NOT DISTINCT FROM OLD.lease_expires_at
          AND NEW.reconnect_expires_at IS NOT DISTINCT FROM OLD.reconnect_expires_at);
        IF NOT valid_transition THEN
          RAISE EXCEPTION 'session control current generation transition invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_session_control_event_insert_guard()
      RETURNS trigger AS $$
      DECLARE auth_related BOOLEAN := FALSE;
      DECLARE auth_exact BOOLEAN := FALSE;
      BEGIN
        IF NEW.request_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM chat_session_control_requests request_row
          WHERE request_row.request_id = NEW.request_id
            AND request_row.workspace_id = NEW.workspace_id AND request_row.session_id = NEW.session_id
            AND request_row.companion_session_id = NEW.companion_session_id
            AND request_row.device_grant_id = NEW.device_grant_id
        ) THEN
          RAISE EXCEPTION 'session control event request attribution invariant violated' USING ERRCODE = '23514';
        END IF;
        SELECT EXISTS (SELECT 1 FROM chat_session_control_auth_revoke_operations operation
          WHERE operation.request_sha256 = NEW.request_sha256
            AND NOT EXISTS (SELECT 1 FROM chat_session_control_auth_revoke_receipts receipt
              WHERE receipt.idempotency_key = operation.idempotency_key))
          OR EXISTS (SELECT 1 FROM chat_session_control_auth_revoke_operations operation
            WHERE operation.idempotency_key = NEW.idempotency_key)
          OR EXISTS (SELECT 1 FROM chat_session_control_auth_revoke_operation_targets target
            WHERE target.event_idempotency_key = NEW.idempotency_key) INTO auth_related;
        IF auth_related THEN
          SELECT EXISTS (
            SELECT 1 FROM chat_session_control_auth_revoke_operation_targets target
            JOIN chat_session_control_auth_revoke_operations operation
              ON operation.idempotency_key = target.operation_idempotency_key
            WHERE target.event_id = NEW.event_id AND target.event_sequence = NEW.event_sequence
              AND target.event_idempotency_key = NEW.idempotency_key
              AND target.event_reason_code = NEW.reason_code
              AND target.workspace_id = NEW.workspace_id AND target.session_id = NEW.session_id
              AND operation.request_sha256 = NEW.request_sha256
              AND operation.correlation_id = NEW.correlation_id AND operation.actor_id = NEW.actor_id
              AND NEW.actor_kind = 'system' AND operation.occurred_at = NEW.created_at
              AND NOT EXISTS (SELECT 1 FROM chat_session_control_auth_revoke_receipts receipt
                WHERE receipt.idempotency_key = operation.idempotency_key)
              AND ((target.target_kind = 'pending_request' AND NEW.request_id = target.request_id
                    AND NEW.previous_generation = target.generation AND NEW.next_generation = target.generation
                    AND NEW.previous_owner_kind = target.owner_kind AND NEW.next_owner_kind = target.owner_kind
                    AND NEW.previous_lease_state = target.lease_state AND NEW.next_lease_state = target.lease_state)
                OR (target.target_kind = 'current_grant' AND NEW.request_id = target.request_id
                    AND NEW.previous_generation = target.generation AND NEW.next_generation = target.generation + 1
                    AND NEW.previous_owner_kind = 'external_companion' AND NEW.next_owner_kind = 'operator'
                    AND NEW.previous_lease_state = target.lease_state AND NEW.next_lease_state = 'operator_active'))
          ) INTO auth_exact;
          IF NOT auth_exact THEN
            RAISE EXCEPTION 'session control auth revoke event invariant violated' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_session_control_auth_revoke_receipt_insert_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM chat_session_control_auth_revoke_operations operation
          WHERE operation.idempotency_key = NEW.idempotency_key
            AND operation.request_sha256 = NEW.request_sha256
            AND operation.binding_kind = NEW.binding_kind AND operation.binding_id = NEW.binding_id
            AND operation.actor_id = NEW.actor_id AND operation.correlation_id = NEW.correlation_id
            AND operation.target_count = NEW.target_count AND operation.session_count = NEW.session_count
            AND operation.event_set_sha256 = NEW.event_set_sha256 AND operation.occurred_at = NEW.created_at
            AND (SELECT COUNT(*) FROM chat_session_control_auth_revoke_operation_targets target
                 WHERE target.operation_idempotency_key = operation.idempotency_key) = operation.target_count
            AND (SELECT COUNT(DISTINCT (target.workspace_id, target.session_id))
                 FROM chat_session_control_auth_revoke_operation_targets target
                 WHERE target.operation_idempotency_key = operation.idempotency_key) = operation.session_count
            AND NOT EXISTS (
              SELECT 1 FROM chat_session_control_auth_revoke_operation_targets target
              LEFT JOIN chat_session_control_events event_row
                ON event_row.event_id = target.event_id AND event_row.event_sequence = target.event_sequence
                AND event_row.idempotency_key = target.event_idempotency_key
                AND event_row.reason_code = target.event_reason_code
                AND event_row.workspace_id = target.workspace_id AND event_row.session_id = target.session_id
                AND event_row.request_sha256 = operation.request_sha256
                AND event_row.correlation_id = operation.correlation_id
                AND event_row.actor_kind = 'system' AND event_row.actor_id = operation.actor_id
                AND event_row.created_at = operation.occurred_at
              WHERE target.operation_idempotency_key = operation.idempotency_key AND event_row.event_id IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM chat_session_control_events event_row
              WHERE event_row.request_sha256 = operation.request_sha256
                AND NOT EXISTS (SELECT 1 FROM chat_session_control_auth_revoke_operation_targets target
                  WHERE target.operation_idempotency_key = operation.idempotency_key
                    AND target.event_id = event_row.event_id)
            )
            AND NOT EXISTS (
              SELECT 1 FROM chat_session_control_auth_revoke_operation_targets target
              WHERE target.operation_idempotency_key = operation.idempotency_key AND (
                (target.target_kind = 'pending_request' AND NOT EXISTS (
                  SELECT 1 FROM chat_session_control_requests request_row
                  WHERE request_row.request_id = target.request_id
                    AND request_row.status IN ('cancelled', 'expired')
                    AND request_row.decided_at = operation.occurred_at
                    AND request_row.decided_by_actor_id = operation.actor_id))
                OR (target.target_kind = 'current_grant' AND (
                  NOT EXISTS (SELECT 1 FROM chat_session_control_grants prior
                    WHERE prior.session_id = target.session_id AND prior.generation = target.generation
                      AND prior.is_current = 0 AND prior.lease_state = 'revoked'
                      AND prior.control_revision = target.control_revision + 1
                      AND prior.updated_at = operation.occurred_at AND prior.terminal_at = operation.occurred_at)
                  OR NOT EXISTS (SELECT 1 FROM chat_session_control_grants successor
                    WHERE successor.session_id = target.session_id AND successor.generation = target.generation + 1
                      AND successor.workspace_id = target.workspace_id AND successor.is_current = 1
                      AND successor.owner_kind = 'operator' AND successor.lease_state = 'operator_active'
                      AND successor.transition_idempotency_key = target.event_idempotency_key
                      AND successor.transition_request_sha256 = operation.request_sha256
                      AND successor.created_at = operation.occurred_at AND successor.updated_at = operation.occurred_at)))
              ))
        ) THEN
          RAISE EXCEPTION 'session control auth revoke receipt invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `,
  },
  {
    version: 116,
    name: "durable_heartbeat_occurrence_authority",
    sql: `
      DO $heartbeat_preempted_reason_upgrade$
      DECLARE constraint_row RECORD;
      BEGIN
        LOCK TABLE chat_session_control_events IN ACCESS EXCLUSIVE MODE;
        FOR constraint_row IN
          SELECT constraint_def.conname
          FROM pg_constraint constraint_def
          WHERE constraint_def.conrelid = to_regclass('chat_session_control_events')
            AND constraint_def.contype = 'c'
            AND pg_get_constraintdef(constraint_def.oid) LIKE '%reason_code%'
            AND pg_get_constraintdef(constraint_def.oid) LIKE '%request_created%'
            AND pg_get_constraintdef(constraint_def.oid) LIKE '%mutation_denied%'
        LOOP
          EXECUTE format(
            'ALTER TABLE chat_session_control_events DROP CONSTRAINT %I',
            constraint_row.conname
          );
        END LOOP;
        ALTER TABLE chat_session_control_events
          ADD CONSTRAINT gc_sce_reason_code CHECK(reason_code IN (
            'session_initialized', 'request_created', 'request_rejected', 'request_expired',
            'request_cancelled', 'handoff', 'heartbeat', 'lease_stale', 'reconnect',
            'identity_revoked', 'release', 'operator_revoke', 'emergency_takeover',
            'auth_revoked', 'session_deleted', 'session_reactivated', 'mutation_denied',
            'heartbeat_preempted'
          ));
      END;
      $heartbeat_preempted_reason_upgrade$;

      DO $heartbeat_preemption_control_clock_guards$
      DECLARE function_sql TEXT;
      DECLARE upgraded_sql TEXT;
      DECLARE anchor TEXT := 'AND NOT auth_bypass) THEN';
      BEGIN
        SELECT pg_get_functiondef(to_regprocedure('gc_session_control_request_transition_guard()'))
          INTO function_sql;
        IF function_sql IS NULL THEN
          RAISE EXCEPTION 'Postgres migration 116 requires the session-control request transition guard'
            USING ERRCODE = '23514';
        END IF;
        IF strpos(function_sql, 'heartbeat-preempt-request_') = 0 THEN
          upgraded_sql := replace(function_sql, anchor, $request_clock_evidence$AND NOT auth_bypass
            AND NOT EXISTS (
              SELECT 1 FROM chat_session_control_events event_row
              WHERE left(event_row.idempotency_key, 26) = 'heartbeat-preempt-request_'
                AND event_row.workspace_id = OLD.workspace_id
                AND event_row.session_id = OLD.session_id
                AND event_row.request_id = OLD.request_id
                AND event_row.previous_generation = OLD.requested_generation
                AND event_row.next_generation = OLD.requested_generation
                AND event_row.previous_owner_kind = 'operator'
                AND event_row.next_owner_kind = 'operator'
                AND event_row.previous_lease_state = 'operator_active'
                AND event_row.next_lease_state = 'operator_active'
                AND event_row.reason_code = NEW.decision_reason_code
                AND ((NEW.status = 'expired' AND event_row.reason_code = 'request_expired')
                  OR (NEW.status = 'cancelled' AND event_row.reason_code = 'request_cancelled'))
                AND event_row.actor_kind = 'operator'
                AND event_row.actor_id = NEW.decided_by_actor_id
                AND event_row.companion_session_id = OLD.companion_session_id
                AND event_row.device_grant_id = OLD.device_grant_id
                AND event_row.created_at = NEW.decided_at
            )) THEN$request_clock_evidence$);
          IF upgraded_sql = function_sql THEN
            RAISE EXCEPTION 'Postgres migration 116 could not upgrade the request clock guard'
              USING ERRCODE = '23514';
          END IF;
          EXECUTE upgraded_sql;
        END IF;

        SELECT pg_get_functiondef(to_regprocedure('gc_session_control_grant_update_guard()'))
          INTO function_sql;
        IF function_sql IS NULL THEN
          RAISE EXCEPTION 'Postgres migration 116 requires the session-control grant update guard'
            USING ERRCODE = '23514';
        END IF;
        IF strpos(function_sql, 'heartbeat preemption grant terminal clock evidence') = 0 THEN
          upgraded_sql := replace(function_sql, anchor, $grant_update_clock_evidence$AND NOT auth_bypass
            AND NOT EXISTS (
              SELECT 1 FROM chat_session_control_events event_row
              WHERE left(event_row.idempotency_key, 18) = 'heartbeat-preempt_'
                /* heartbeat preemption grant terminal clock evidence */
                AND event_row.workspace_id = OLD.workspace_id
                AND event_row.session_id = OLD.session_id
                AND event_row.request_id IS NULL
                AND event_row.previous_generation = OLD.generation
                AND event_row.next_generation = OLD.generation + 1
                AND event_row.previous_owner_kind = 'operator'
                AND event_row.next_owner_kind = 'operator'
                AND event_row.previous_lease_state = 'operator_active'
                AND event_row.next_lease_state = 'operator_active'
                AND event_row.reason_code = 'heartbeat_preempted'
                AND event_row.actor_kind = 'operator'
                AND event_row.companion_session_id IS NULL
                AND event_row.device_grant_id IS NULL
                AND event_row.created_at = NEW.updated_at
                AND NEW.terminal_at = NEW.updated_at
            )) THEN$grant_update_clock_evidence$);
          IF upgraded_sql = function_sql THEN
            RAISE EXCEPTION 'Postgres migration 116 could not upgrade the grant update clock guard'
              USING ERRCODE = '23514';
          END IF;
          EXECUTE upgraded_sql;
        END IF;

        SELECT pg_get_functiondef(to_regprocedure('gc_session_control_grant_insert_guard()'))
          INTO function_sql;
        IF function_sql IS NULL THEN
          RAISE EXCEPTION 'Postgres migration 116 requires the session-control grant insert guard'
            USING ERRCODE = '23514';
        END IF;
        IF strpos(function_sql, 'heartbeat preemption successor clock evidence') = 0 THEN
          upgraded_sql := replace(function_sql, anchor, $grant_insert_clock_evidence$AND NOT auth_bypass
            AND NOT EXISTS (
              SELECT 1 FROM chat_session_control_events event_row
              WHERE left(event_row.idempotency_key, 18) = 'heartbeat-preempt_'
                /* heartbeat preemption successor clock evidence */
                AND event_row.workspace_id = NEW.workspace_id
                AND event_row.session_id = NEW.session_id
                AND event_row.request_id IS NULL
                AND event_row.previous_generation = NEW.generation - 1
                AND event_row.next_generation = NEW.generation
                AND event_row.previous_owner_kind = 'operator'
                AND event_row.next_owner_kind = 'operator'
                AND event_row.previous_lease_state = 'operator_active'
                AND event_row.next_lease_state = 'operator_active'
                AND event_row.reason_code = 'heartbeat_preempted'
                AND event_row.actor_kind = 'operator'
                AND event_row.companion_session_id IS NULL
                AND event_row.device_grant_id IS NULL
                AND event_row.idempotency_key = NEW.transition_idempotency_key
                AND event_row.request_sha256 = NEW.transition_request_sha256
                AND event_row.created_at = NEW.created_at
                AND NEW.updated_at = NEW.created_at
            )) THEN$grant_insert_clock_evidence$);
          IF upgraded_sql = function_sql THEN
            RAISE EXCEPTION 'Postgres migration 116 could not upgrade the grant insert clock guard'
              USING ERRCODE = '23514';
          END IF;
          EXECUTE upgraded_sql;
        END IF;
      END;
      $heartbeat_preemption_control_clock_guards$;

      CREATE OR REPLACE FUNCTION gc_heartbeat_preempted_event_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.reason_code = 'heartbeat_preempted' AND NOT (
          NEW.request_id IS NULL
          AND NEW.previous_generation IS NOT NULL
          AND NEW.next_generation = NEW.previous_generation + 1
          AND NEW.previous_owner_kind = 'operator' AND NEW.next_owner_kind = 'operator'
          AND NEW.previous_lease_state = 'operator_active' AND NEW.next_lease_state = 'operator_active'
          AND NEW.actor_kind = 'operator'
          AND NEW.companion_session_id IS NULL AND NEW.device_grant_id IS NULL
          AND NEW.event_sequence = COALESCE((
            SELECT MAX(prior_event.event_sequence) + 1
            FROM chat_session_control_events prior_event
            WHERE prior_event.session_id = NEW.session_id
          ), 1)
          AND EXISTS (
            SELECT 1 FROM chat_session_control_grants prior
            WHERE prior.workspace_id = NEW.workspace_id AND prior.session_id = NEW.session_id
              AND prior.generation = NEW.previous_generation
              AND prior.owner_kind = 'operator' AND prior.lease_state = 'operator_active'
              AND prior.is_current = 1 AND prior.terminal_at IS NULL
            )
          AND NOT EXISTS (
            SELECT 1 FROM chat_session_control_grants successor
            WHERE successor.workspace_id = NEW.workspace_id AND successor.session_id = NEW.session_id
              AND successor.generation = NEW.next_generation
          )
        ) THEN
          RAISE EXCEPTION 'heartbeat preemption event invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_chat_session_control_events_heartbeat_preempted_guard
        ON chat_session_control_events;
      CREATE TRIGGER trg_chat_session_control_events_heartbeat_preempted_guard
        BEFORE INSERT ON chat_session_control_events FOR EACH ROW
        EXECUTE FUNCTION gc_heartbeat_preempted_event_guard();

      CREATE OR REPLACE FUNCTION gc_heartbeat_preempted_settlement_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NOT (
          EXISTS (
            SELECT 1 FROM chat_session_control_grants prior
            WHERE prior.workspace_id = NEW.workspace_id AND prior.session_id = NEW.session_id
              AND prior.generation = NEW.previous_generation
              AND prior.owner_kind = 'operator' AND prior.lease_state = 'superseded'
              AND prior.is_current = 0 AND prior.terminal_at = NEW.created_at
              AND prior.updated_at = NEW.created_at
          )
          AND EXISTS (
            SELECT 1 FROM chat_session_control_grants successor
            WHERE successor.workspace_id = NEW.workspace_id AND successor.session_id = NEW.session_id
              AND successor.generation = NEW.next_generation AND successor.is_current = 1
              AND successor.owner_kind = 'operator' AND successor.lease_state = 'operator_active'
              AND successor.transition_idempotency_key = NEW.idempotency_key
              AND successor.transition_request_sha256 = NEW.request_sha256
              AND successor.created_at = NEW.created_at AND successor.updated_at = NEW.created_at
          )
          AND NOT EXISTS (
            SELECT 1 FROM chat_session_control_requests request_row
            WHERE request_row.workspace_id = NEW.workspace_id AND request_row.session_id = NEW.session_id
              AND request_row.requested_generation = NEW.previous_generation
              AND request_row.status = 'pending'
          )
          AND EXISTS (
            SELECT 1 FROM chat_heartbeat_occurrences occurrence
            JOIN chat_session_mutation_admissions heartbeat_admission
              ON heartbeat_admission.admission_id = occurrence.admission_id
            WHERE occurrence.workspace_id = NEW.workspace_id AND occurrence.session_id = NEW.session_id
              AND occurrence.controller_generation = NEW.previous_generation
              AND occurrence.state = 'abandoned' AND occurrence.abandoned_at = NEW.created_at
              AND heartbeat_admission.status = 'cancelled'
              AND ((occurrence.abandonment_reason = 'admission_closed'
                AND occurrence.durable_run_id IS NULL
                AND heartbeat_admission.terminal_authority_kind = 'request_runtime'
                AND heartbeat_admission.terminal_control_event_id IS NULL
                AND heartbeat_admission.terminal_correlation_id = NEW.event_id)
              OR (occurrence.abandonment_reason = 'authority_drift'
                AND occurrence.durable_run_id = occurrence.expected_durable_run_id
                AND heartbeat_admission.terminal_authority_kind = 'authority_superseded'
                AND heartbeat_admission.terminal_control_event_id = NEW.event_id))
          )
          AND EXISTS (
            SELECT 1 FROM chat_session_mutation_admissions operator_admission
            WHERE operator_admission.workspace_id = NEW.workspace_id
              AND operator_admission.session_id = NEW.session_id
              AND operator_admission.controller_generation = NEW.next_generation
              AND operator_admission.admission_kind = 'turn_write'
              AND operator_admission.actor_kind = 'operator'
              AND operator_admission.actor_id = NEW.actor_id
              AND operator_admission.correlation_id = NEW.correlation_id
              AND operator_admission.status = 'active'
          )
        ) THEN
          RAISE EXCEPTION 'heartbeat preemption settlement invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_chat_session_control_events_heartbeat_preempted_settlement
        ON chat_session_control_events;
      CREATE CONSTRAINT TRIGGER trg_chat_session_control_events_heartbeat_preempted_settlement
        AFTER INSERT ON chat_session_control_events
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW WHEN (NEW.reason_code = 'heartbeat_preempted')
        EXECUTE FUNCTION gc_heartbeat_preempted_settlement_guard();

      CREATE OR REPLACE FUNCTION gc_heartbeat_preempted_operator_generation_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.owner_kind = 'operator' AND EXISTS (
          SELECT 1 FROM chat_session_control_grants prior
          WHERE prior.session_id = NEW.session_id AND prior.workspace_id = NEW.workspace_id
            AND prior.generation = NEW.generation - 1
            AND prior.owner_kind = 'operator' AND prior.lease_state = 'superseded'
        ) AND NOT EXISTS (
          SELECT 1 FROM chat_session_control_events event_row
          WHERE event_row.workspace_id = NEW.workspace_id AND event_row.session_id = NEW.session_id
            AND event_row.previous_generation = NEW.generation - 1
            AND event_row.next_generation = NEW.generation
            AND event_row.previous_owner_kind = 'operator' AND event_row.next_owner_kind = 'operator'
            AND event_row.previous_lease_state = 'operator_active'
            AND event_row.next_lease_state = 'operator_active'
            AND event_row.reason_code = 'heartbeat_preempted' AND event_row.actor_kind = 'operator'
            AND event_row.request_id IS NULL AND event_row.companion_session_id IS NULL
            AND event_row.device_grant_id IS NULL
            AND event_row.idempotency_key = NEW.transition_idempotency_key
            AND event_row.request_sha256 = NEW.transition_request_sha256
            AND event_row.created_at = NEW.created_at AND NEW.updated_at = NEW.created_at
        ) THEN
          RAISE EXCEPTION 'operator heartbeat-preemption generation lacks its exact event'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_chat_session_control_grants_heartbeat_preempted_guard
        ON chat_session_control_grants;
      CREATE TRIGGER trg_chat_session_control_grants_heartbeat_preempted_guard
        BEFORE INSERT ON chat_session_control_grants FOR EACH ROW
        EXECUTE FUNCTION gc_heartbeat_preempted_operator_generation_guard();

      CREATE TABLE IF NOT EXISTS chat_heartbeat_occurrences (
        occurrence_id TEXT PRIMARY KEY CHECK(length(occurrence_id) BETWEEN 1 AND 256),
        workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
        session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
        session_incarnation_id TEXT NOT NULL CHECK(length(session_incarnation_id) BETWEEN 1 AND 320),
        admission_id TEXT NOT NULL UNIQUE CHECK(length(admission_id) BETWEEN 1 AND 256),
        admission_request_sha256 TEXT NOT NULL CHECK(admission_request_sha256 ~ '^[0-9a-f]{64}$'),
        admission_idempotency_key TEXT NOT NULL CHECK(length(admission_idempotency_key) BETWEEN 1 AND 512),
        admission_correlation_id TEXT NOT NULL CHECK(length(admission_correlation_id) BETWEEN 1 AND 256),
        runtime_owner_id TEXT NOT NULL CHECK(length(runtime_owner_id) BETWEEN 1 AND 256),
        system_actor_id TEXT NOT NULL CHECK(system_actor_id = 'system-heartbeat'),
        admission_material_sha256 TEXT NOT NULL CHECK(admission_material_sha256 ~ '^[0-9a-f]{64}$'),
        evaluated_policy_sha256 TEXT NOT NULL CHECK(evaluated_policy_sha256 ~ '^[0-9a-f]{64}$'),
        frozen_request_sha256 TEXT NOT NULL CHECK(frozen_request_sha256 ~ '^[0-9a-f]{64}$'),
        frozen_objective_sha256 TEXT NOT NULL CHECK(frozen_objective_sha256 ~ '^[0-9a-f]{64}$'),
        claim_sha256 TEXT NOT NULL UNIQUE CHECK(claim_sha256 ~ '^[0-9a-f]{64}$'),
        aggregate_revision BIGINT NOT NULL CHECK(aggregate_revision > 0),
        controller_generation BIGINT NOT NULL CHECK(controller_generation > 0),
        prior_last_proactive_at TEXT CHECK(
          prior_last_proactive_at IS NULL OR gc_try_parse_timestamptz(prior_last_proactive_at) IS NOT NULL
        ),
        prior_last_proactive_run_id TEXT CHECK(
          prior_last_proactive_run_id IS NULL OR length(prior_last_proactive_run_id) BETWEEN 1 AND 256
        ),
        heartbeat_interval_seconds BIGINT NOT NULL CHECK(heartbeat_interval_seconds BETWEEN 900 AND 86400),
        cooldown_seconds BIGINT NOT NULL CHECK(cooldown_seconds BETWEEN 0 AND 3600),
        idle_floor_seconds BIGINT NOT NULL CHECK(idle_floor_seconds BETWEEN 0 AND 86400),
        observed_session_activity_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(observed_session_activity_at) IS NOT NULL
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
          capability_profile_hash IS NULL OR capability_profile_hash ~ '^[0-9a-f]{64}$'
        ),
        state TEXT NOT NULL CHECK(state IN ('admitted', 'durable_bound', 'terminal', 'abandoned')),
        revision BIGINT NOT NULL CHECK(revision > 0),
        claimed_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(claimed_at) IS NOT NULL),
        durable_bound_at TEXT CHECK(
          durable_bound_at IS NULL OR gc_try_parse_timestamptz(durable_bound_at) IS NOT NULL
        ),
        terminal_at TEXT CHECK(terminal_at IS NULL OR gc_try_parse_timestamptz(terminal_at) IS NOT NULL),
        abandoned_at TEXT CHECK(abandoned_at IS NULL OR gc_try_parse_timestamptz(abandoned_at) IS NOT NULL),
        terminal_status TEXT CHECK(
          terminal_status IS NULL OR terminal_status IN ('completed', 'failed', 'cancelled')
        ),
        terminal_handoff_sha256 TEXT CHECK(
          terminal_handoff_sha256 IS NULL OR terminal_handoff_sha256 ~ '^[0-9a-f]{64}$'
        ),
        abandonment_reason TEXT CHECK(
          abandonment_reason IS NULL OR abandonment_reason IN ('admission_closed', 'authority_drift', 'lifecycle_drift')
        ),
        updated_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(updated_at) IS NOT NULL),
        CONSTRAINT fk_chat_heartbeat_occurrence_admission
          FOREIGN KEY(admission_id) REFERENCES chat_session_mutation_admissions(admission_id)
          ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT fk_chat_heartbeat_occurrence_durable_run
          FOREIGN KEY(durable_run_id) REFERENCES durable_runs(run_id)
          ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT fk_chat_heartbeat_occurrence_capability_profile
          FOREIGN KEY(capability_profile_id) REFERENCES chat_turn_capability_profiles(profile_id)
          ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
        CHECK(admission_material_sha256 = frozen_request_sha256),
        CHECK((prior_last_proactive_at IS NULL) = (prior_last_proactive_run_id IS NULL)),
        CHECK(
          (state = 'admitted' AND durable_bound_at IS NULL AND terminal_at IS NULL AND abandoned_at IS NULL
            AND terminal_status IS NULL AND terminal_handoff_sha256 IS NULL AND abandonment_reason IS NULL
            AND durable_run_id IS NULL AND capability_profile_id IS NULL AND capability_profile_hash IS NULL
            AND revision = 1 AND updated_at = claimed_at)
          OR (state = 'durable_bound' AND durable_bound_at IS NOT NULL AND terminal_at IS NULL AND abandoned_at IS NULL
            AND terminal_status IS NULL AND terminal_handoff_sha256 IS NULL AND abandonment_reason IS NULL
            AND durable_run_id IS NOT NULL AND durable_run_id = expected_durable_run_id
            AND capability_profile_id IS NOT NULL AND capability_profile_hash IS NOT NULL)
          OR (state = 'terminal' AND durable_bound_at IS NOT NULL AND terminal_at IS NOT NULL AND abandoned_at IS NULL
            AND terminal_status IS NOT NULL AND terminal_handoff_sha256 IS NOT NULL AND abandonment_reason IS NULL
            AND durable_run_id IS NOT NULL AND durable_run_id = expected_durable_run_id
            AND capability_profile_id IS NOT NULL AND capability_profile_hash IS NOT NULL)
          OR (state = 'abandoned' AND terminal_at IS NULL AND abandoned_at IS NOT NULL
            AND terminal_status IS NULL AND terminal_handoff_sha256 IS NULL AND abandonment_reason IS NOT NULL
            AND (
              (durable_bound_at IS NULL AND durable_run_id IS NULL
                AND capability_profile_id IS NULL AND capability_profile_hash IS NULL)
              OR (abandonment_reason = 'authority_drift' AND durable_bound_at IS NOT NULL
                AND durable_run_id IS NOT NULL AND durable_run_id = expected_durable_run_id
                AND capability_profile_id IS NOT NULL AND capability_profile_hash IS NOT NULL)
            ))
        )
      );

      DO $heartbeat_occurrence_catalog_normalize$
      DECLARE constraint_row RECORD;
      DECLARE check_count INTEGER;
      DECLARE fk_count INTEGER;
      BEGIN
        LOCK TABLE chat_heartbeat_occurrences IN ACCESS EXCLUSIVE MODE;
        IF EXISTS (SELECT 1 FROM chat_heartbeat_occurrences) THEN
          RAISE EXCEPTION 'heartbeat occurrence catalog normalization requires the new table to be empty'
            USING ERRCODE = '23514';
        END IF;
        FOR constraint_row IN
          SELECT constraint_def.conname
          FROM pg_constraint constraint_def
          WHERE constraint_def.conrelid = to_regclass('chat_heartbeat_occurrences')
            AND constraint_def.contype IN ('c', 'f')
        LOOP
          EXECUTE format('ALTER TABLE chat_heartbeat_occurrences DROP CONSTRAINT %I', constraint_row.conname);
        END LOOP;

        ALTER TABLE chat_heartbeat_occurrences
          ADD CONSTRAINT gc_hbo_identity_shape CHECK(
            length(occurrence_id) BETWEEN 1 AND 256
            AND length(workspace_id) BETWEEN 1 AND 256
            AND length(session_id) BETWEEN 1 AND 256
            AND length(session_incarnation_id) BETWEEN 1 AND 320
            AND length(admission_id) BETWEEN 1 AND 256
            AND admission_request_sha256 ~ '^[0-9a-f]{64}$'
            AND length(admission_idempotency_key) BETWEEN 1 AND 512
            AND length(admission_correlation_id) BETWEEN 1 AND 256
            AND length(runtime_owner_id) BETWEEN 1 AND 256
            AND system_actor_id = 'system-heartbeat'
            AND admission_material_sha256 ~ '^[0-9a-f]{64}$'
            AND evaluated_policy_sha256 ~ '^[0-9a-f]{64}$'
            AND frozen_request_sha256 ~ '^[0-9a-f]{64}$'
            AND admission_material_sha256 = frozen_request_sha256
            AND frozen_objective_sha256 ~ '^[0-9a-f]{64}$'
            AND claim_sha256 ~ '^[0-9a-f]{64}$'
            AND aggregate_revision > 0 AND controller_generation > 0
            AND (prior_last_proactive_at IS NULL OR (
              gc_try_parse_timestamptz(prior_last_proactive_at) IS NOT NULL
              AND to_char(gc_try_parse_timestamptz(prior_last_proactive_at) AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = prior_last_proactive_at
            ))
            AND (prior_last_proactive_run_id IS NULL OR length(prior_last_proactive_run_id) BETWEEN 1 AND 256)
            AND heartbeat_interval_seconds BETWEEN 900 AND 86400
            AND cooldown_seconds BETWEEN 0 AND 3600
            AND idle_floor_seconds BETWEEN 0 AND 86400
            AND gc_try_parse_timestamptz(observed_session_activity_at) IS NOT NULL
            AND to_char(gc_try_parse_timestamptz(observed_session_activity_at) AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = observed_session_activity_at
            AND length(user_message_id) BETWEEN 1 AND 256
            AND length(assistant_message_id) BETWEEN 1 AND 256
            AND length(turn_id) BETWEEN 1 AND 256
            AND length(expected_durable_run_id) BETWEEN 1 AND 256
            AND (durable_run_id IS NULL OR length(durable_run_id) BETWEEN 1 AND 256)
            AND (capability_profile_id IS NULL OR length(capability_profile_id) BETWEEN 1 AND 256)
            AND (capability_profile_hash IS NULL OR capability_profile_hash ~ '^[0-9a-f]{64}$')
            AND state IN ('admitted', 'durable_bound', 'terminal', 'abandoned')
            AND revision > 0
            AND gc_try_parse_timestamptz(claimed_at) IS NOT NULL
            AND to_char(gc_try_parse_timestamptz(claimed_at) AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = claimed_at
            AND (durable_bound_at IS NULL OR (
              gc_try_parse_timestamptz(durable_bound_at) IS NOT NULL
              AND to_char(gc_try_parse_timestamptz(durable_bound_at) AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = durable_bound_at
            ))
            AND (terminal_at IS NULL OR (
              gc_try_parse_timestamptz(terminal_at) IS NOT NULL
              AND to_char(gc_try_parse_timestamptz(terminal_at) AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = terminal_at
            ))
            AND (abandoned_at IS NULL OR (
              gc_try_parse_timestamptz(abandoned_at) IS NOT NULL
              AND to_char(gc_try_parse_timestamptz(abandoned_at) AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = abandoned_at
            ))
            AND (terminal_status IS NULL OR terminal_status IN ('completed', 'failed', 'cancelled'))
            AND (terminal_handoff_sha256 IS NULL OR terminal_handoff_sha256 ~ '^[0-9a-f]{64}$')
            AND (abandonment_reason IS NULL OR abandonment_reason IN (
              'admission_closed', 'authority_drift', 'lifecycle_drift'
            ))
            AND gc_try_parse_timestamptz(updated_at) IS NOT NULL
            AND to_char(gc_try_parse_timestamptz(updated_at) AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = updated_at
          ),
          ADD CONSTRAINT gc_hbo_prior_cadence_pair CHECK(
            (prior_last_proactive_at IS NULL) = (prior_last_proactive_run_id IS NULL)
          ),
          ADD CONSTRAINT gc_hbo_state_shape CHECK(
            (state = 'admitted' AND durable_bound_at IS NULL AND terminal_at IS NULL AND abandoned_at IS NULL
              AND terminal_status IS NULL AND terminal_handoff_sha256 IS NULL AND abandonment_reason IS NULL
              AND durable_run_id IS NULL AND capability_profile_id IS NULL AND capability_profile_hash IS NULL
              AND revision = 1 AND updated_at = claimed_at)
            OR (state = 'durable_bound' AND durable_bound_at IS NOT NULL AND terminal_at IS NULL
              AND abandoned_at IS NULL AND terminal_status IS NULL AND terminal_handoff_sha256 IS NULL
              AND abandonment_reason IS NULL AND durable_run_id IS NOT NULL
              AND durable_run_id = expected_durable_run_id
              AND capability_profile_id IS NOT NULL AND capability_profile_hash IS NOT NULL)
            OR (state = 'terminal' AND durable_bound_at IS NOT NULL AND terminal_at IS NOT NULL
              AND abandoned_at IS NULL AND terminal_status IS NOT NULL AND terminal_handoff_sha256 IS NOT NULL
              AND abandonment_reason IS NULL AND durable_run_id IS NOT NULL
              AND durable_run_id = expected_durable_run_id
              AND capability_profile_id IS NOT NULL AND capability_profile_hash IS NOT NULL)
            OR (state = 'abandoned' AND terminal_at IS NULL
              AND abandoned_at IS NOT NULL AND terminal_status IS NULL AND terminal_handoff_sha256 IS NULL
              AND abandonment_reason IS NOT NULL AND (
                (durable_bound_at IS NULL AND durable_run_id IS NULL
                  AND capability_profile_id IS NULL AND capability_profile_hash IS NULL)
                OR (abandonment_reason = 'authority_drift' AND durable_bound_at IS NOT NULL
                  AND durable_run_id IS NOT NULL AND durable_run_id = expected_durable_run_id
                  AND capability_profile_id IS NOT NULL AND capability_profile_hash IS NOT NULL)
              ))
          ),
          ADD CONSTRAINT fk_chat_heartbeat_occurrence_admission
            FOREIGN KEY(admission_id) REFERENCES chat_session_mutation_admissions(admission_id)
            ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
          ADD CONSTRAINT fk_chat_heartbeat_occurrence_durable_run
            FOREIGN KEY(durable_run_id) REFERENCES durable_runs(run_id)
            ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
          ADD CONSTRAINT fk_chat_heartbeat_occurrence_capability_profile
            FOREIGN KEY(capability_profile_id) REFERENCES chat_turn_capability_profiles(profile_id)
            ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

        SELECT COUNT(*) INTO check_count
        FROM pg_constraint constraint_def
        WHERE constraint_def.conrelid = to_regclass('chat_heartbeat_occurrences')
          AND constraint_def.contype = 'c' AND constraint_def.convalidated
          AND constraint_def.conname IN ('gc_hbo_identity_shape', 'gc_hbo_prior_cadence_pair', 'gc_hbo_state_shape');
        SELECT COUNT(*) INTO fk_count
        FROM pg_constraint constraint_def
        WHERE constraint_def.conrelid = to_regclass('chat_heartbeat_occurrences')
          AND constraint_def.contype = 'f' AND constraint_def.condeferrable AND constraint_def.condeferred
          AND constraint_def.convalidated AND constraint_def.confdeltype = 'a' AND constraint_def.confupdtype = 'a'
          AND constraint_def.conname IN (
            'fk_chat_heartbeat_occurrence_admission',
            'fk_chat_heartbeat_occurrence_durable_run',
            'fk_chat_heartbeat_occurrence_capability_profile'
          );
        IF check_count <> 3 OR fk_count <> 3 THEN
          RAISE EXCEPTION 'heartbeat occurrence catalog normalization assertion failed' USING ERRCODE = '23514';
        END IF;
      END;
      $heartbeat_occurrence_catalog_normalize$;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_heartbeat_occurrences_one_open
        ON chat_heartbeat_occurrences(session_id)
        WHERE state IN ('admitted', 'durable_bound');
      CREATE INDEX IF NOT EXISTS idx_chat_heartbeat_occurrences_recovery
        ON chat_heartbeat_occurrences(state, updated_at, occurrence_id);
      CREATE INDEX IF NOT EXISTS idx_chat_heartbeat_occurrences_session
        ON chat_heartbeat_occurrences(workspace_id, session_id, claimed_at, occurrence_id);

      CREATE OR REPLACE FUNCTION gc_heartbeat_occurrence_insert_guard()
      RETURNS trigger AS $$
      DECLARE database_now TIMESTAMPTZ := clock_timestamp();
      BEGIN
        IF NEW.state <> 'admitted' OR NEW.revision <> 1 OR NEW.updated_at <> NEW.claimed_at
          OR NEW.admission_material_sha256 <> NEW.frozen_request_sha256
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.claimed_at) - database_now))) > 1
          OR NOT EXISTS (
          SELECT 1 FROM chat_session_mutation_admissions admission
          WHERE admission.admission_id = NEW.admission_id
            AND admission.workspace_id = NEW.workspace_id
            AND admission.session_id = NEW.session_id
            AND admission.session_incarnation_id = NEW.session_incarnation_id
            AND admission.turn_id = NEW.turn_id
            AND admission.runtime_owner_id = NEW.runtime_owner_id
            AND admission.actor_kind = 'system'
            AND admission.actor_id = NEW.system_actor_id
            AND admission.operation = 'chat_system_heartbeat'
            AND admission.material_sha256 = NEW.admission_material_sha256
            AND admission.request_sha256 = NEW.admission_request_sha256
            AND admission.idempotency_key = NEW.admission_idempotency_key
            AND admission.correlation_id = NEW.admission_correlation_id
            AND admission.aggregate_revision = NEW.aggregate_revision
            AND admission.controller_generation = NEW.controller_generation
            AND admission.status = 'active'
        ) OR NOT EXISTS (
          SELECT 1 FROM session_autonomy_prefs prefs
          WHERE prefs.session_id = NEW.session_id
            AND prefs.last_proactive_at = NEW.claimed_at
            AND prefs.last_proactive_run_id = NEW.occurrence_id
        ) OR EXISTS (
          SELECT 1 FROM chat_messages message
          WHERE message.message_id IN (NEW.user_message_id, NEW.assistant_message_id)
        ) THEN
          RAISE EXCEPTION 'heartbeat occurrence admission or cadence invariant violated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

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
            OR NOT EXISTS (
              SELECT 1 FROM chat_turn_capability_profile_incarnation_bindings profile_binding
              WHERE profile_binding.profile_id = NEW.capability_profile_id
                AND profile_binding.turn_id = OLD.turn_id
                AND profile_binding.profile_hash = NEW.capability_profile_hash
            )
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

      CREATE OR REPLACE FUNCTION gc_canonical_jsonb(value JSONB)
      RETURNS TEXT AS $$
      DECLARE body TEXT;
      BEGIN
        IF value IS NULL THEN RETURN NULL; END IF;
        CASE jsonb_typeof(value)
          WHEN 'object' THEN
            SELECT COALESCE(string_agg(
              to_jsonb(entry.key)::TEXT || ':' || gc_canonical_jsonb(entry.value),
              ',' ORDER BY entry.key COLLATE "C"
            ), '') INTO body
            FROM jsonb_each(value) entry;
            RETURN '{' || body || '}';
          WHEN 'array' THEN
            SELECT COALESCE(string_agg(
              gc_canonical_jsonb(entry.value), ',' ORDER BY entry.ordinality
            ), '') INTO body
            FROM jsonb_array_elements(value) WITH ORDINALITY entry(value, ordinality);
            RETURN '[' || body || ']';
          ELSE
            RETURN value::TEXT;
        END CASE;
      END;
      $$ LANGUAGE plpgsql IMMUTABLE STRICT;

      CREATE OR REPLACE FUNCTION gc_sha256_text(value TEXT)
      RETURNS TEXT AS $$
        SELECT encode(sha256(convert_to(value, 'UTF8')), 'hex');
      $$ LANGUAGE sql IMMUTABLE STRICT;

      CREATE OR REPLACE FUNCTION gc_js_trim(value TEXT)
      RETURNS TEXT AS $$
        SELECT btrim(value, U&'\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF');
      $$ LANGUAGE sql IMMUTABLE STRICT;

      CREATE OR REPLACE FUNCTION gc_unicode_scalar_length(value TEXT)
      RETURNS INTEGER AS $$
        SELECT char_length(value);
      $$ LANGUAGE sql IMMUTABLE STRICT;

      CREATE OR REPLACE FUNCTION gc_heartbeat_decision_raw_is_exact(value TEXT)
      RETURNS BOOLEAN AS $$
      DECLARE parsed JSON;
      DECLARE key_count INTEGER;
      DECLARE normalized_message TEXT;
      BEGIN
        parsed := value::JSON;
        IF json_typeof(parsed) <> 'object' THEN RETURN FALSE; END IF;
        SELECT COUNT(*) INTO key_count FROM json_each(parsed);
        IF EXISTS (SELECT 1 FROM json_each(parsed) field WHERE field.key NOT IN ('message', 'notify')) THEN
          RETURN FALSE;
        END IF;
        IF json_typeof(parsed -> 'notify') = 'boolean' AND (parsed ->> 'notify')::BOOLEAN = FALSE THEN
          RETURN key_count = 1;
        END IF;
        IF json_typeof(parsed -> 'notify') = 'boolean' AND (parsed ->> 'notify')::BOOLEAN = TRUE
          AND key_count = 2 AND json_typeof(parsed -> 'message') = 'string' THEN
          normalized_message := gc_js_trim(parsed ->> 'message');
          RETURN gc_unicode_scalar_length(normalized_message) BETWEEN 1 AND 4000;
        END IF;
        RETURN FALSE;
      EXCEPTION WHEN OTHERS THEN
        RETURN FALSE;
      END;
      $$ LANGUAGE plpgsql IMMUTABLE STRICT;

      CREATE OR REPLACE FUNCTION gc_heartbeat_decision_notify(value TEXT)
      RETURNS BOOLEAN AS $$
        SELECT CASE WHEN gc_heartbeat_decision_raw_is_exact(value)
          THEN ((value::JSON) ->> 'notify')::BOOLEAN ELSE NULL END;
      $$ LANGUAGE sql IMMUTABLE STRICT;

      CREATE OR REPLACE FUNCTION gc_heartbeat_decision_normalized_message(value TEXT)
      RETURNS TEXT AS $$
        SELECT CASE WHEN gc_heartbeat_decision_raw_is_exact(value)
          AND ((value::JSON) ->> 'notify')::BOOLEAN
          THEN gc_js_trim((value::JSON) ->> 'message') ELSE NULL END;
      $$ LANGUAGE sql IMMUTABLE STRICT;

      CREATE OR REPLACE FUNCTION gc_heartbeat_occurrence_terminal_evidence_guard()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.state = 'durable_bound' AND NEW.state = 'terminal' AND NOT EXISTS (
          SELECT 1
          FROM (
            SELECT run.*,
                   gc_try_parse_jsonb(run.payload_json) AS payload,
                   gc_try_parse_jsonb(run.metadata_json) AS metadata
            FROM durable_runs run
            WHERE run.run_id = OLD.durable_run_id
          ) run
          JOIN chat_turn_traces trace ON trace.turn_id = OLD.turn_id
          WHERE run.workflow_key = 'chat.turn.execute'
            AND run.status = NEW.terminal_status
            AND run.status IN ('completed', 'failed', 'cancelled')
            AND run.lease_owner_id IS NULL AND run.lease_expires_at IS NULL
            AND jsonb_typeof(run.payload) = 'object' AND jsonb_typeof(run.metadata) = 'object'
            AND jsonb_typeof(run.metadata -> 'autonomousAdmission') = 'object'
            AND (
              SELECT COUNT(*) FROM jsonb_object_keys(run.metadata -> 'autonomousAdmission')
            ) = 2
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_object_keys(run.metadata -> 'autonomousAdmission') admission_seal_field
              WHERE admission_seal_field NOT IN ('material', 'materialSha256')
            )
            AND jsonb_typeof(run.metadata #> '{autonomousAdmission,material}') = 'object'
            AND (
              SELECT COUNT(*) FROM jsonb_object_keys(run.metadata #> '{autonomousAdmission,material}')
            ) = 8
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_object_keys(
                run.metadata #> '{autonomousAdmission,material}'
              ) autonomous_material_field
              WHERE autonomous_material_field NOT IN (
                'version', 'identity', 'sessionId', 'objectiveSha256', 'autonomous',
                'admission', 'capability', 'cronAdmission'
              )
            )
            AND run.metadata #>> '{autonomousAdmission,material,version}' = 'chat.autonomous.admission.v1'
            AND run.metadata #>> '{autonomousAdmission,materialSha256}'
              = gc_sha256_text(gc_canonical_jsonb(run.metadata #> '{autonomousAdmission,material}'))
            AND run.metadata #>> '{autonomousAdmission,material,identity,userMessageId}'
              = run.payload ->> 'userMessageId'
            AND run.metadata #>> '{autonomousAdmission,material,identity,assistantMessageId}'
              = run.payload ->> 'assistantMessageId'
            AND run.metadata #>> '{autonomousAdmission,material,identity,turnId}' = OLD.turn_id
            AND run.metadata #>> '{autonomousAdmission,material,identity,durableRunId}' = run.run_id
            AND run.metadata #>> '{autonomousAdmission,material,sessionId}' = OLD.session_id
            AND jsonb_typeof(run.metadata -> 'objective') = 'string'
            AND run.metadata ->> 'objective' = run.payload #>> '{request,content}'
            AND run.metadata #>> '{autonomousAdmission,material,objectiveSha256}'
              = gc_sha256_text(gc_canonical_jsonb(run.metadata -> 'objective'))
            AND jsonb_typeof(run.metadata #> '{autonomousAdmission,material,autonomous}') = 'object'
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_object_keys(
                run.metadata #> '{autonomousAdmission,material,autonomous}'
              ) autonomous_field
              WHERE autonomous_field NOT IN (
                'kind', 'systemActorId', 'sourceRunId', 'reason', 'deliverMode',
                'deliveryChannel', 'profilePosture', 'commitmentId'
              )
            )
            AND run.metadata #>> '{autonomousAdmission,material,autonomous,kind}' = 'heartbeat'
            AND run.metadata #>> '{autonomousAdmission,material,autonomous,systemActorId}' = 'system-heartbeat'
            AND run.metadata #>> '{autonomousAdmission,material,autonomous,deliverMode}' = 'on_notify'
            AND length(run.metadata #>> '{autonomousAdmission,material,autonomous,sourceRunId}') BETWEEN 1 AND 256
            AND length(run.metadata #>> '{autonomousAdmission,material,autonomous,reason}') BETWEEN 1 AND 4096
            AND run.metadata -> 'autonomous'
              = run.metadata #> '{autonomousAdmission,material,autonomous}'
            AND run.payload #>> '{requestActor,actorKind}' = 'system'
            AND run.payload #>> '{requestActor,actorId}' = 'system-heartbeat'
            AND run.metadata #>> '{autonomousAdmission,material,admission,admissionId}'
              = run.payload ->> 'admissionId'
            AND run.metadata #>> '{autonomousAdmission,material,admission,sessionIncarnationId}'
              = run.payload ->> 'sessionIncarnationId'
            AND run.metadata #>> '{autonomousAdmission,material,admission,workspaceId}'
              = run.payload ->> 'workspaceId'
            AND run.metadata #>> '{autonomousAdmission,material,admission,admissionMaterialSha256}'
              = run.payload ->> 'admissionMaterialSha256'
            AND run.metadata #>> '{autonomousAdmission,material,admission,effectiveRequestMaterialSha256}'
              = run.payload ->> 'effectiveRequestMaterialSha256'
            AND run.metadata #>> '{autonomousAdmission,material,capability,profileId}'
              = run.payload ->> 'capabilityProfileId'
            AND run.metadata #>> '{autonomousAdmission,material,capability,profileHash}'
              = run.payload ->> 'capabilityProfileHash'
            AND run.metadata #>> '{autonomousAdmission,material,capability,profileId}'
              = run.metadata ->> 'capabilityProfileId'
            AND run.metadata #>> '{autonomousAdmission,material,capability,profileHash}'
              = run.metadata ->> 'capabilityProfileHash'
            AND length(run.metadata #>> '{autonomousAdmission,material,capability,snapshotId}') BETWEEN 1 AND 256
            AND jsonb_typeof(run.metadata #> '{autonomousAdmission,material,cronAdmission}') = 'null'
            AND jsonb_typeof(run.metadata -> 'chatTurnRuntimeAuthority') = 'object'
            AND jsonb_typeof(run.metadata #> '{chatTurnRuntimeAuthority,material}') = 'object'
            AND (
              SELECT COUNT(*) FROM jsonb_object_keys(run.metadata -> 'chatTurnRuntimeAuthority')
            ) = 2
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_object_keys(run.metadata -> 'chatTurnRuntimeAuthority') authority_field
              WHERE authority_field NOT IN ('material', 'materialSha256')
            )
            AND (
              SELECT COUNT(*) FROM jsonb_object_keys(
                run.metadata #> '{chatTurnRuntimeAuthority,material}'
              )
            ) = CASE run.status WHEN 'completed' THEN 14 ELSE 13 END
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_object_keys(
                run.metadata #> '{chatTurnRuntimeAuthority,material}'
              ) material_field
              WHERE material_field NOT IN (
                'version', 'runId', 'turnId', 'transitionKind', 'durableStatus', 'traceStatus',
                'transitionAt', 'postCommitGenerationId', 'postCommitEligibility', 'waitForEvent',
                'terminalOutput', 'linkedFinalization', 'requiredFinalizers', 'heartbeatDecisionReceipt'
              )
            )
            AND (
              (run.status = 'completed'
                AND jsonb_typeof(run.metadata #> '{chatTurnRuntimeAuthority,material,heartbeatDecisionReceipt}')
                  = 'object')
              OR (run.status IN ('failed', 'cancelled')
                AND NOT (run.metadata #> '{chatTurnRuntimeAuthority,material}' ? 'heartbeatDecisionReceipt'))
            )
            AND run.metadata #>> '{chatTurnRuntimeAuthority,materialSha256}'
              = gc_sha256_text(gc_canonical_jsonb(
                  run.metadata #> '{chatTurnRuntimeAuthority,material}'
                ))
            AND run.metadata #>> '{chatTurnRuntimeAuthority,material,version}'
              = 'chat.turn.runtime-authority.v1'
            AND run.metadata #>> '{chatTurnRuntimeAuthority,material,runId}' = run.run_id
            AND run.metadata #>> '{chatTurnRuntimeAuthority,material,turnId}' = OLD.turn_id
            AND run.metadata #>> '{chatTurnRuntimeAuthority,material,durableStatus}' = run.status
            AND run.metadata #>> '{chatTurnRuntimeAuthority,material,traceStatus}' = trace.status
            AND gc_try_parse_timestamptz(
                  run.metadata #>> '{chatTurnRuntimeAuthority,material,transitionAt}'
                ) IS NOT NULL
            AND to_char(gc_try_parse_timestamptz(
                  run.metadata #>> '{chatTurnRuntimeAuthority,material,transitionAt}'
                ) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              = run.metadata #>> '{chatTurnRuntimeAuthority,material,transitionAt}'
            AND jsonb_typeof(run.metadata #> '{chatTurnRuntimeAuthority,material,postCommitEligibility}')
              = 'object'
            AND (
              SELECT COUNT(*) FROM jsonb_object_keys(
                run.metadata #> '{chatTurnRuntimeAuthority,material,postCommitEligibility}'
              )
            ) = 4
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_object_keys(
                run.metadata #> '{chatTurnRuntimeAuthority,material,postCommitEligibility}'
              ) eligibility_field
              WHERE eligibility_field NOT IN (
                'version', 'autonomyEnabledAtParentSettlement', 'evalIntegrityTurn', 'humanSession'
              )
            )
            AND run.metadata #>> '{chatTurnRuntimeAuthority,material,postCommitEligibility,version}' = '1'
            AND run.metadata #> '{chatTurnRuntimeAuthority,material,postCommitEligibility,autonomyEnabledAtParentSettlement}'
              = 'false'::jsonb
            AND run.metadata #> '{chatTurnRuntimeAuthority,material,postCommitEligibility,evalIntegrityTurn}'
              = 'false'::jsonb
            AND run.metadata #> '{chatTurnRuntimeAuthority,material,postCommitEligibility,humanSession}'
              = 'false'::jsonb
            AND jsonb_typeof(run.metadata #> '{chatTurnRuntimeAuthority,material,waitForEvent}') = 'null'
            AND NOT (run.metadata ? 'waitForEvent')
            AND NOT (run.metadata ? 'linkedFinalizationPending')
            AND NOT (run.metadata ? 'autonomousChatPostCommitPending')
            AND NOT (run.metadata ? 'generalChatPostCommitPending')
            AND trace.session_id = OLD.session_id
            AND trace.user_message_id = run.payload ->> 'userMessageId'
            AND trace.assistant_message_id = run.payload ->> 'assistantMessageId'
            AND NOT EXISTS (
              SELECT 1 FROM chat_messages heartbeat_input
              WHERE heartbeat_input.message_id = trace.user_message_id
            )
            AND jsonb_typeof(gc_try_parse_jsonb(trace.durable_json)) = 'object'
            AND gc_try_parse_jsonb(trace.durable_json) ->> 'runId' = run.run_id
            AND gc_try_parse_jsonb(trace.durable_json) ->> 'status' = run.status
            AND gc_try_parse_jsonb(trace.durable_json) ->> 'checkpointKind' = CASE run.status
              WHEN 'completed' THEN 'run_completed'
              WHEN 'failed' THEN 'run_failed'
              ELSE 'run_cancelled'
            END
            AND (
              (run.status = 'completed' AND trace.status = 'completed')
              OR (run.status IN ('failed', 'cancelled') AND trace.status = run.status)
            )
            AND EXISTS (
              SELECT 1
              FROM durable_checkpoints checkpoint
              WHERE checkpoint.checkpoint_id = (
                  SELECT latest.checkpoint_id
                  FROM durable_checkpoints latest
                  WHERE latest.run_id = run.run_id
                    AND latest.checkpoint_kind = CASE run.status
                      WHEN 'completed' THEN 'run_completed'
                      WHEN 'failed' THEN 'run_failed'
                      ELSE 'run_cancelled'
                    END
                  ORDER BY latest.created_at DESC, latest.checkpoint_id DESC LIMIT 1
                )
                AND jsonb_typeof(gc_try_parse_jsonb(checkpoint.state_json)) = 'object'
                AND gc_try_parse_jsonb(checkpoint.state_json) -> 'chatTurnRuntimeAuthority'
                  = run.metadata -> 'chatTurnRuntimeAuthority'
                AND (
                  (run.status = 'completed'
                    AND jsonb_typeof(run.metadata -> 'heartbeatDecisionReceipt') = 'object'
                    AND jsonb_typeof(gc_try_parse_jsonb(checkpoint.state_json)
                      -> 'heartbeatDecisionReceipt') = 'object'
                    AND jsonb_typeof(run.metadata -> 'heartbeatDecisionRawOutput') = 'string'
                    AND jsonb_typeof(gc_try_parse_jsonb(checkpoint.state_json)
                      -> 'heartbeatDecisionRawOutput') = 'string'
                    AND run.metadata -> 'heartbeatDecisionReceipt'
                      = run.metadata #> '{chatTurnRuntimeAuthority,material,heartbeatDecisionReceipt}'
                    AND gc_try_parse_jsonb(checkpoint.state_json) -> 'heartbeatDecisionReceipt'
                      = run.metadata -> 'heartbeatDecisionReceipt'
                    AND gc_try_parse_jsonb(checkpoint.state_json) ->> 'heartbeatDecisionRawOutput'
                      = run.metadata ->> 'heartbeatDecisionRawOutput'
                    AND (
                      SELECT COUNT(*) FROM jsonb_object_keys(run.metadata -> 'heartbeatDecisionReceipt')
                    ) = 6
                    AND NOT EXISTS (
                      SELECT 1 FROM jsonb_object_keys(
                        run.metadata -> 'heartbeatDecisionReceipt'
                      ) receipt_field
                      WHERE receipt_field NOT IN (
                        'version', 'occurrenceId', 'claimSha256', 'rawOutputSha256',
                        'notify', 'normalizedMessageSha256'
                      )
                    )
                    AND run.metadata #>> '{heartbeatDecisionReceipt,version}' = '1'
                    AND run.metadata #>> '{heartbeatDecisionReceipt,occurrenceId}' = OLD.occurrence_id
                    AND run.metadata #>> '{heartbeatDecisionReceipt,claimSha256}' = OLD.claim_sha256
                    AND run.metadata #>> '{heartbeatDecisionReceipt,rawOutputSha256}'
                      = gc_sha256_text(run.metadata ->> 'heartbeatDecisionRawOutput')
                    AND gc_heartbeat_decision_raw_is_exact(
                      run.metadata ->> 'heartbeatDecisionRawOutput'
                    )
                    AND run.metadata #> '{heartbeatDecisionReceipt,notify}'
                      = to_jsonb(gc_heartbeat_decision_notify(
                        run.metadata ->> 'heartbeatDecisionRawOutput'
                      ))
                    AND (
                      (gc_heartbeat_decision_notify(run.metadata ->> 'heartbeatDecisionRawOutput') = FALSE
                        AND jsonb_typeof(run.metadata
                          #> '{heartbeatDecisionReceipt,normalizedMessageSha256}') = 'null')
                      OR
                      (gc_heartbeat_decision_notify(run.metadata ->> 'heartbeatDecisionRawOutput') = TRUE
                        AND run.metadata #>> '{heartbeatDecisionReceipt,normalizedMessageSha256}'
                          = gc_sha256_text(gc_heartbeat_decision_normalized_message(
                            run.metadata ->> 'heartbeatDecisionRawOutput'
                          )))
                    ))
                  OR
                  (run.status IN ('failed', 'cancelled')
                    AND NOT (run.metadata ? 'heartbeatDecisionReceipt')
                    AND NOT (run.metadata ? 'heartbeatDecisionRawOutput')
                    AND NOT (gc_try_parse_jsonb(checkpoint.state_json) ? 'heartbeatDecisionReceipt')
                    AND NOT (gc_try_parse_jsonb(checkpoint.state_json) ? 'heartbeatDecisionRawOutput'))
                )
                AND (
                  (run.status = 'completed'
                    AND (
                      (gc_heartbeat_decision_notify(run.metadata ->> 'heartbeatDecisionRawOutput') = TRUE
                        AND gc_try_parse_jsonb(checkpoint.state_json) ->> 'assistantMessageId'
                          = run.payload ->> 'assistantMessageId'
                        AND gc_try_parse_jsonb(checkpoint.state_json) ->> 'outputText'
                          = run.metadata ->> 'outputText'
                        AND gc_try_parse_jsonb(checkpoint.state_json) ->> 'outputSummary'
                          = run.metadata ->> 'outputSummary')
                      OR
                      (gc_heartbeat_decision_notify(run.metadata ->> 'heartbeatDecisionRawOutput') = FALSE
                        AND NOT (gc_try_parse_jsonb(checkpoint.state_json) ? 'assistantMessageId')
                        AND NOT (gc_try_parse_jsonb(checkpoint.state_json) ? 'outputText')
                        AND NOT (gc_try_parse_jsonb(checkpoint.state_json) ? 'outputSummary'))
                    ))
                  OR (run.status IN ('failed', 'cancelled')
                    AND NOT (gc_try_parse_jsonb(checkpoint.state_json) ? 'assistantMessageId')
                    AND NOT (gc_try_parse_jsonb(checkpoint.state_json) ? 'outputText')
                    AND NOT (gc_try_parse_jsonb(checkpoint.state_json) ? 'outputSummary'))
                )
            )
            AND (
              (run.metadata #>> '{chatTurnRuntimeAuthority,material,transitionKind}' = 'linked_finalization'
                AND run.status = 'failed'
                AND run.metadata #> '{chatTurnRuntimeAuthority,material,requiredFinalizers}'
                  = '["linked","general"]'::jsonb
                AND jsonb_typeof(run.metadata #> '{chatTurnRuntimeAuthority,material,linkedFinalization}')
                  = 'object'
                AND jsonb_typeof(run.metadata -> 'linkedFinalization') = 'object'
                AND run.metadata #>> '{linkedFinalization,finalizationId}'
                  = run.metadata #>> '{chatTurnRuntimeAuthority,material,linkedFinalization,finalizationId}'
                AND run.metadata #>> '{linkedFinalization,requestedAt}'
                  = run.metadata #>> '{chatTurnRuntimeAuthority,material,linkedFinalization,requestedAt}'
                AND run.metadata #>> '{linkedFinalization,reasonSha256}'
                  = run.metadata #>> '{chatTurnRuntimeAuthority,material,linkedFinalization,reasonSha256}'
                AND jsonb_typeof(run.metadata #> '{chatTurnRuntimeAuthority,material,terminalOutput}') = 'null'
                AND NOT (run.metadata ? 'autonomousChatPostCommit'))
              OR
              (run.metadata #>> '{chatTurnRuntimeAuthority,material,transitionKind}' = 'terminal'
                AND jsonb_typeof(run.metadata #> '{chatTurnRuntimeAuthority,material,linkedFinalization}') = 'null'
                AND NOT (run.metadata ? 'linkedFinalization')
                AND (
                  (run.status = 'completed'
                    AND jsonb_typeof(run.metadata -> 'autonomousChatPostCommit') = 'object'
                    AND run.metadata #> '{chatTurnRuntimeAuthority,material,requiredFinalizers}'
                      = '["autonomous","general"]'::jsonb
                    AND run.metadata #>> '{autonomousChatPostCommit,generationId}'
                      = run.metadata #>> '{chatTurnRuntimeAuthority,material,postCommitGenerationId}'
                    AND run.metadata #>> '{autonomousChatPostCommit,requestedAt}'
                      = run.metadata #>> '{chatTurnRuntimeAuthority,material,transitionAt}'
                    AND jsonb_typeof(run.metadata #> '{autonomousChatPostCommit,completedAt}') = 'string'
                    AND run.metadata #> '{autonomousChatPostCommit,heartbeatCleanup}'
                      = '{"status":"not_required"}'::jsonb
                    AND (
                      (gc_heartbeat_decision_notify(run.metadata ->> 'heartbeatDecisionRawOutput') = FALSE
                        AND jsonb_typeof(run.metadata
                          #> '{chatTurnRuntimeAuthority,material,terminalOutput}') = 'null'
                        AND NOT (run.metadata ? 'outputText') AND NOT (run.metadata ? 'finalOutput')
                        AND NOT (run.metadata ? 'outputSummary') AND NOT (run.metadata ? 'finalSummary')
                        AND NOT EXISTS (
                          SELECT 1 FROM chat_messages message
                          WHERE message.message_id = run.payload ->> 'assistantMessageId'
                        ))
                      OR
                      (gc_heartbeat_decision_notify(run.metadata ->> 'heartbeatDecisionRawOutput') = TRUE
                        AND jsonb_typeof(run.metadata
                          #> '{chatTurnRuntimeAuthority,material,terminalOutput}') = 'object'
                        AND (
                          SELECT COUNT(*) FROM jsonb_object_keys(
                            run.metadata #> '{chatTurnRuntimeAuthority,material,terminalOutput}'
                          )
                        ) = 3
                        AND NOT EXISTS (
                          SELECT 1 FROM jsonb_object_keys(
                            run.metadata #> '{chatTurnRuntimeAuthority,material,terminalOutput}'
                          ) output_field
                          WHERE output_field NOT IN (
                            'assistantMessageId', 'outputTextSha256', 'outputSummarySha256'
                          )
                        )
                        AND jsonb_typeof(run.metadata -> 'outputText') = 'string'
                        AND jsonb_typeof(run.metadata -> 'outputSummary') = 'string'
                        AND run.metadata ->> 'outputText'
                          = gc_heartbeat_decision_normalized_message(
                            run.metadata ->> 'heartbeatDecisionRawOutput'
                          )
                        AND run.metadata #>> '{chatTurnRuntimeAuthority,material,terminalOutput,assistantMessageId}'
                          = run.payload ->> 'assistantMessageId'
                        AND run.metadata #>> '{chatTurnRuntimeAuthority,material,terminalOutput,outputTextSha256}'
                          = gc_sha256_text(gc_canonical_jsonb(run.metadata -> 'outputText'))
                        AND run.metadata #>> '{chatTurnRuntimeAuthority,material,terminalOutput,outputSummarySha256}'
                          = gc_sha256_text(gc_canonical_jsonb(run.metadata -> 'outputSummary'))
                        AND run.metadata ->> 'finalOutput' = run.metadata ->> 'outputText'
                        AND run.metadata ->> 'finalSummary' = run.metadata ->> 'outputSummary'
                        AND EXISTS (
                          SELECT 1 FROM chat_messages message
                          WHERE message.message_id = run.payload ->> 'assistantMessageId'
                            AND message.session_id = OLD.session_id
                            AND message.role = 'assistant' AND message.actor_type = 'system'
                            AND message.actor_id = 'system-heartbeat'
                            AND message.content = run.metadata ->> 'outputText'
                        ))
                    ))
                  OR
                  (run.status IN ('failed', 'cancelled')
                    AND jsonb_typeof(run.metadata #> '{chatTurnRuntimeAuthority,material,terminalOutput}') = 'null'
                    AND NOT (run.metadata ? 'outputText') AND NOT (run.metadata ? 'finalOutput')
                    AND NOT (run.metadata ? 'outputSummary') AND NOT (run.metadata ? 'finalSummary')
                    AND NOT (run.metadata ? 'autonomousChatPostCommit')
                    AND run.metadata #> '{chatTurnRuntimeAuthority,material,requiredFinalizers}'
                      = '["general"]'::jsonb)
                ))
            )
            AND jsonb_typeof(run.metadata -> 'generalChatPostCommit') = 'object'
            AND run.metadata #>> '{generalChatPostCommit,generationId}'
              = run.metadata #>> '{chatTurnRuntimeAuthority,material,postCommitGenerationId}'
            AND run.metadata #>> '{generalChatPostCommit,traceStatus}' = trace.status
            AND run.metadata #>> '{generalChatPostCommit,requestedAt}'
              = run.metadata #>> '{chatTurnRuntimeAuthority,material,transitionAt}'
            AND run.metadata #> '{generalChatPostCommit,postCommitEligibility}'
              = run.metadata #> '{chatTurnRuntimeAuthority,material,postCommitEligibility}'
            AND run.metadata #>> '{generalChatPostCommit,parentLocalEffectsStatus}' = 'settled'
            AND jsonb_typeof(run.metadata #> '{generalChatPostCommit,parentLocalEffectsSettledAt}') = 'string'
            AND jsonb_typeof(run.metadata #> '{generalChatPostCommit,completedEffects}') = 'array'
            AND jsonb_typeof(run.metadata #> '{generalChatPostCommit,durableEffectRunIds}') = 'object'
            AND jsonb_typeof(run.metadata #> '{generalChatPostCommit,durableEffectOutcomes}') = 'object'
            AND jsonb_array_length(run.metadata #> '{generalChatPostCommit,completedEffects}') = 0
            AND (
              SELECT COUNT(*) FROM jsonb_object_keys(
                run.metadata #> '{generalChatPostCommit,durableEffectRunIds}'
              )
            ) = 0
            AND (
              SELECT COUNT(*) FROM jsonb_object_keys(
                run.metadata #> '{generalChatPostCommit,durableEffectOutcomes}'
              )
            ) = 0
            AND run.metadata #>> '{generalChatPostCommit,childOutcomeAuthority}' = 'child_durable_runs'
            AND run.metadata #>> '{generalChatPostCommit,settlementStatus}'
              IN ('completed', 'settled_with_failures')
            AND jsonb_typeof(run.metadata #> '{generalChatPostCommit,completedAt}') = 'string'
            AND (
              SELECT COUNT(*) FROM jsonb_each_text(
                CASE WHEN jsonb_typeof(run.metadata #> '{generalChatPostCommit,durableEffectRunIds}') = 'object'
                  THEN run.metadata #> '{generalChatPostCommit,durableEffectRunIds}' ELSE '{}'::jsonb END
              )
            ) = (
              SELECT COUNT(DISTINCT child_id.value) FROM jsonb_each_text(
                CASE WHEN jsonb_typeof(run.metadata #> '{generalChatPostCommit,durableEffectRunIds}') = 'object'
                  THEN run.metadata #> '{generalChatPostCommit,durableEffectRunIds}' ELSE '{}'::jsonb END
              ) child_id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM jsonb_each_text(
                CASE WHEN jsonb_typeof(run.metadata #> '{generalChatPostCommit,durableEffectRunIds}') = 'object'
                  THEN run.metadata #> '{generalChatPostCommit,durableEffectRunIds}' ELSE '{}'::jsonb END
              ) effect_run
              LEFT JOIN jsonb_each(
                CASE WHEN jsonb_typeof(run.metadata #> '{generalChatPostCommit,durableEffectOutcomes}') = 'object'
                  THEN run.metadata #> '{generalChatPostCommit,durableEffectOutcomes}' ELSE '{}'::jsonb END
              ) effect_outcome ON effect_outcome.key = effect_run.key
              LEFT JOIN durable_runs child_run ON child_run.run_id = effect_run.value
              LEFT JOIN chat_session_mutation_admissions child_admission
                ON child_admission.admission_id = gc_try_parse_jsonb(child_run.payload_json)
                  #>> '{childAdmission,admissionId}'
              WHERE effect_run.key NOT IN ('background_review', 'commitments', 'memory_maintenance')
                OR effect_outcome.key IS NULL OR jsonb_typeof(effect_outcome.value) <> 'object'
                OR effect_outcome.value ->> 'runId' <> effect_run.value
                OR child_run.run_id IS NULL OR child_run.workflow_key <> 'chat.post_commit.effect'
                OR child_run.status NOT IN ('completed', 'failed', 'cancelled', 'dead_lettered')
                OR child_run.status <> effect_outcome.value ->> 'status'
                OR child_run.lease_owner_id IS NOT NULL OR child_run.lease_expires_at IS NOT NULL
                OR gc_try_parse_jsonb(child_run.payload_json) ->> 'parentRunId' <> run.run_id
                OR gc_try_parse_jsonb(child_run.payload_json) ->> 'postCommitGenerationId'
                  <> run.metadata #>> '{generalChatPostCommit,generationId}'
                OR gc_try_parse_jsonb(child_run.payload_json) ->> 'effect' <> effect_run.key
                OR child_admission.admission_id IS NULL
                OR child_admission.status <> CASE child_run.status
                  WHEN 'completed' THEN 'completed' ELSE 'cancelled' END
                OR child_admission.terminal_authority_kind <> 'post_commit_child_stage'
                OR child_admission.terminal_durable_run_id <> child_run.run_id
                OR child_admission.terminal_durable_run_status <> 'running'
                OR child_admission.terminal_durable_lease_owner_id IS NULL
                OR child_admission.terminal_durable_attempt_count IS NULL
                OR child_admission.terminal_durable_run_version IS NULL
            )
            AND NOT EXISTS (
              SELECT 1
              FROM jsonb_each(
                CASE WHEN jsonb_typeof(run.metadata #> '{generalChatPostCommit,durableEffectOutcomes}') = 'object'
                  THEN run.metadata #> '{generalChatPostCommit,durableEffectOutcomes}' ELSE '{}'::jsonb END
              ) effect_outcome
              LEFT JOIN jsonb_each_text(
                CASE WHEN jsonb_typeof(run.metadata #> '{generalChatPostCommit,durableEffectRunIds}') = 'object'
                  THEN run.metadata #> '{generalChatPostCommit,durableEffectRunIds}' ELSE '{}'::jsonb END
              ) effect_run ON effect_run.key = effect_outcome.key
              WHERE effect_run.key IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM durable_runs omitted_child
              WHERE omitted_child.workflow_key = 'chat.post_commit.effect'
                AND gc_try_parse_jsonb(omitted_child.payload_json) ->> 'parentRunId' = run.run_id
                AND gc_try_parse_jsonb(omitted_child.payload_json) ->> 'postCommitGenerationId'
                  = run.metadata #>> '{generalChatPostCommit,generationId}'
                AND NOT EXISTS (
                  SELECT 1 FROM jsonb_each_text(
                    CASE WHEN jsonb_typeof(run.metadata #> '{generalChatPostCommit,durableEffectRunIds}') = 'object'
                      THEN run.metadata #> '{generalChatPostCommit,durableEffectRunIds}' ELSE '{}'::jsonb END
                  ) admitted_child WHERE admitted_child.value = omitted_child.run_id
                )
            )
            AND jsonb_typeof(run.metadata -> 'chatTurnAdmissionHandoff') = 'object'
            AND (
              SELECT COUNT(*) FROM jsonb_object_keys(run.metadata -> 'chatTurnAdmissionHandoff')
            ) = 10
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_object_keys(run.metadata -> 'chatTurnAdmissionHandoff') marker_field
              WHERE marker_field NOT IN (
                'version', 'admissionId', 'sessionIncarnationId', 'turnId', 'parentRunId',
                'postCommitGenerationId', 'parentLocalEffectsStatus', 'childRunIds',
                'childRunIdsSha256', 'committedAt'
              )
            )
            AND run.metadata #>> '{chatTurnAdmissionHandoff,version}' = '1'
            AND run.metadata #>> '{chatTurnAdmissionHandoff,admissionId}' = OLD.admission_id
            AND run.metadata #>> '{chatTurnAdmissionHandoff,sessionIncarnationId}' = OLD.session_incarnation_id
            AND run.metadata #>> '{chatTurnAdmissionHandoff,turnId}' = OLD.turn_id
            AND run.metadata #>> '{chatTurnAdmissionHandoff,parentRunId}' = run.run_id
            AND run.metadata #>> '{chatTurnAdmissionHandoff,postCommitGenerationId}'
              = run.metadata #>> '{generalChatPostCommit,generationId}'
            AND run.metadata #>> '{chatTurnAdmissionHandoff,parentLocalEffectsStatus}' = 'settled'
            AND jsonb_typeof(run.metadata #> '{chatTurnAdmissionHandoff,childRunIds}') = 'array'
            AND run.metadata #>> '{chatTurnAdmissionHandoff,childRunIdsSha256}'
              = gc_sha256_text(gc_canonical_jsonb(
                  run.metadata #> '{chatTurnAdmissionHandoff,childRunIds}'
                ))
            AND gc_try_parse_timestamptz(
                  run.metadata #>> '{chatTurnAdmissionHandoff,committedAt}'
                ) IS NOT NULL
            AND to_char(gc_try_parse_timestamptz(
                  run.metadata #>> '{chatTurnAdmissionHandoff,committedAt}'
                ) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              = run.metadata #>> '{chatTurnAdmissionHandoff,committedAt}'
            AND jsonb_array_length(run.metadata #> '{chatTurnAdmissionHandoff,childRunIds}') = (
              SELECT COUNT(*) FROM jsonb_each_text(
                CASE WHEN jsonb_typeof(run.metadata #> '{generalChatPostCommit,durableEffectRunIds}') = 'object'
                  THEN run.metadata #> '{generalChatPostCommit,durableEffectRunIds}' ELSE '{}'::jsonb END
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(run.metadata #> '{chatTurnAdmissionHandoff,childRunIds}') = 'array'
                  THEN run.metadata #> '{chatTurnAdmissionHandoff,childRunIds}' ELSE '[]'::jsonb END
              ) WITH ORDINALITY marker_child(value, ordinality)
              WHERE EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(
                  CASE WHEN jsonb_typeof(run.metadata #> '{chatTurnAdmissionHandoff,childRunIds}') = 'array'
                    THEN run.metadata #> '{chatTurnAdmissionHandoff,childRunIds}' ELSE '[]'::jsonb END
                ) WITH ORDINALITY prior_marker_child(value, ordinality)
                WHERE prior_marker_child.ordinality < marker_child.ordinality
                  AND prior_marker_child.value >= marker_child.value
              ) OR NOT EXISTS (
                SELECT 1 FROM jsonb_each_text(
                  CASE WHEN jsonb_typeof(run.metadata #> '{generalChatPostCommit,durableEffectRunIds}') = 'object'
                    THEN run.metadata #> '{generalChatPostCommit,durableEffectRunIds}' ELSE '{}'::jsonb END
                ) effect_run WHERE effect_run.value = marker_child.value
              )
            )
        ) THEN
          RAISE EXCEPTION 'heartbeat occurrence terminal runtime evidence invariant violated'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_heartbeat_occurrence_no_delete()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'heartbeat occurrences are append/transition-only' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_chat_heartbeat_occurrences_insert_guard ON chat_heartbeat_occurrences;
      CREATE TRIGGER trg_chat_heartbeat_occurrences_insert_guard
        BEFORE INSERT ON chat_heartbeat_occurrences FOR EACH ROW
        EXECUTE FUNCTION gc_heartbeat_occurrence_insert_guard();
      DROP TRIGGER IF EXISTS trg_chat_heartbeat_occurrences_transition_guard ON chat_heartbeat_occurrences;
      CREATE TRIGGER trg_chat_heartbeat_occurrences_transition_guard
        BEFORE UPDATE ON chat_heartbeat_occurrences FOR EACH ROW
        EXECUTE FUNCTION gc_heartbeat_occurrence_transition_guard();
      DROP TRIGGER IF EXISTS trg_chat_heartbeat_occurrences_terminal_evidence_guard ON chat_heartbeat_occurrences;
      CREATE TRIGGER trg_chat_heartbeat_occurrences_terminal_evidence_guard
        BEFORE UPDATE ON chat_heartbeat_occurrences FOR EACH ROW
        EXECUTE FUNCTION gc_heartbeat_occurrence_terminal_evidence_guard();
      DROP TRIGGER IF EXISTS trg_chat_heartbeat_occurrences_no_delete ON chat_heartbeat_occurrences;
      CREATE TRIGGER trg_chat_heartbeat_occurrences_no_delete
        BEFORE DELETE ON chat_heartbeat_occurrences FOR EACH ROW
        EXECUTE FUNCTION gc_heartbeat_occurrence_no_delete();

      DO $heartbeat_admission_reclaim_guard_upgrade$
      DECLARE function_sql TEXT;
      DECLARE anchor TEXT := $heartbeat_reclaim_anchor$(NEW.status = 'active' AND OLD.status = 'active'
              AND OLD.runtime_lease_relinquished_at IS NULL
              AND gc_try_parse_timestamptz(OLD.runtime_lease_expires_at) > clock_timestamp()$heartbeat_reclaim_anchor$;
      DECLARE replacement TEXT := $heartbeat_reclaim_branch$(NEW.status = 'active' AND OLD.status = 'active'
              /* heartbeat occurrence request-runtime reclaim */
              AND OLD.admission_kind = 'turn_write'
              AND OLD.actor_kind = 'system' AND OLD.actor_id = 'system-heartbeat'
              AND OLD.operation = 'chat_system_heartbeat'
              AND OLD.runtime_lease_relinquished_at IS NULL
              AND gc_try_parse_timestamptz(OLD.runtime_lease_expires_at)
                <= gc_try_parse_timestamptz(NEW.runtime_last_heartbeat_at)
              AND NEW.runtime_lease_relinquished_at IS NULL
              AND NEW.runtime_lease_revision = OLD.runtime_lease_revision + 1
              AND gc_try_parse_timestamptz(NEW.runtime_last_heartbeat_at)
                >= gc_try_parse_timestamptz(OLD.runtime_last_heartbeat_at)
              AND gc_try_parse_timestamptz(NEW.runtime_lease_expires_at)
                = gc_try_parse_timestamptz(NEW.runtime_last_heartbeat_at) + interval '60 seconds'
              AND NEW.closed_at IS NOT DISTINCT FROM OLD.closed_at
              AND NEW.terminal_actor_id IS NOT DISTINCT FROM OLD.terminal_actor_id
              AND NEW.terminal_event_id IS NOT DISTINCT FROM OLD.terminal_event_id
              AND NEW.terminal_idempotency_key IS NOT DISTINCT FROM OLD.terminal_idempotency_key
              AND NEW.terminal_correlation_id IS NOT DISTINCT FROM OLD.terminal_correlation_id
              AND NOT EXISTS (
                SELECT 1 FROM chat_turn_mutation_admission_durable_bindings durable_binding
                WHERE durable_binding.admission_id = OLD.admission_id
              )
              AND EXISTS (
                SELECT 1 FROM chat_heartbeat_occurrences occurrence
                WHERE occurrence.admission_id = OLD.admission_id
                  AND occurrence.workspace_id = OLD.workspace_id
                  AND occurrence.session_id = OLD.session_id
                  AND occurrence.session_incarnation_id = OLD.session_incarnation_id
                  AND occurrence.turn_id = OLD.turn_id
                  AND occurrence.runtime_owner_id = OLD.runtime_owner_id
                  AND occurrence.system_actor_id = OLD.actor_id
                  AND occurrence.admission_material_sha256 = OLD.material_sha256
                  AND occurrence.frozen_request_sha256 = OLD.material_sha256
                  AND occurrence.admission_request_sha256 = OLD.request_sha256
                  AND occurrence.admission_idempotency_key = OLD.idempotency_key
                  AND occurrence.admission_correlation_id = OLD.correlation_id
                  AND occurrence.aggregate_revision = OLD.aggregate_revision
                  AND occurrence.controller_generation = OLD.controller_generation
                  AND occurrence.state = 'admitted'
              ))
            OR $heartbeat_reclaim_branch$;
      DECLARE terminal_effects_anchor TEXT := $heartbeat_terminal_effects_anchor$(
                        SELECT COUNT(DISTINCT local_effect.value #>> '{}')
                        FROM jsonb_array_elements(gc_try_parse_jsonb(run.metadata_json)
                          #> '{generalChatPostCommit,completedEffects}') local_effect(value)
                        WHERE jsonb_typeof(local_effect.value) = 'string'
                          AND local_effect.value #>> '{}' IN ('capability_gap', 'realtime', 'agent_end')
                      ) = 3$heartbeat_terminal_effects_anchor$;
      DECLARE terminal_effects_replacement TEXT := $heartbeat_terminal_effects_branch$(
                        (
                          SELECT COUNT(DISTINCT local_effect.value #>> '{}')
                          FROM jsonb_array_elements(gc_try_parse_jsonb(run.metadata_json)
                            #> '{generalChatPostCommit,completedEffects}') local_effect(value)
                          WHERE jsonb_typeof(local_effect.value) = 'string'
                            AND local_effect.value #>> '{}' IN ('capability_gap', 'realtime', 'agent_end')
                        ) = 3
                        OR (
                          /* heartbeat occurrence durable-terminal zero-effect handoff */
                          OLD.actor_kind = 'system' AND OLD.actor_id = 'system-heartbeat'
                          AND OLD.operation = 'chat_system_heartbeat'
                          AND jsonb_array_length(gc_try_parse_jsonb(run.metadata_json)
                            #> '{generalChatPostCommit,completedEffects}') = 0
                          AND EXISTS (
                            SELECT 1 FROM chat_heartbeat_occurrences heartbeat_occurrence
                            WHERE heartbeat_occurrence.admission_id = OLD.admission_id
                              AND heartbeat_occurrence.workspace_id = OLD.workspace_id
                              AND heartbeat_occurrence.session_id = OLD.session_id
                              AND heartbeat_occurrence.session_incarnation_id = OLD.session_incarnation_id
                              AND heartbeat_occurrence.turn_id = OLD.turn_id
                              AND heartbeat_occurrence.durable_run_id = run.run_id
                              AND heartbeat_occurrence.state = 'durable_bound'
                              AND heartbeat_occurrence.controller_generation = OLD.controller_generation
                              AND heartbeat_occurrence.aggregate_revision = OLD.aggregate_revision
                              AND heartbeat_occurrence.admission_material_sha256 = OLD.material_sha256
                              AND heartbeat_occurrence.frozen_request_sha256 = OLD.material_sha256
                              AND gc_try_parse_jsonb(run.payload_json) ->> 'heartbeatOccurrenceId'
                                = heartbeat_occurrence.occurrence_id
                              AND gc_try_parse_jsonb(run.payload_json) ->> 'heartbeatClaimSha256'
                                = heartbeat_occurrence.claim_sha256
                          )
                        )
                      )$heartbeat_terminal_effects_branch$;
      DECLARE terminal_clock_anchor TEXT := $heartbeat_terminal_clock_anchor$abs(EXTRACT(EPOCH FROM (
                gc_try_parse_timestamptz(NEW.closed_at) - clock_timestamp()
              ))) <= 1$heartbeat_terminal_clock_anchor$;
      DECLARE terminal_clock_replacement TEXT := $heartbeat_terminal_clock_evidence$(
                abs(EXTRACT(EPOCH FROM (
                  gc_try_parse_timestamptz(NEW.closed_at) - clock_timestamp()
                ))) <= 1
                OR EXISTS (
                  SELECT 1
                  FROM chat_session_control_events event_row
                  JOIN chat_session_control_grants successor
                    ON successor.workspace_id = event_row.workspace_id
                    AND successor.session_id = event_row.session_id
                    AND successor.generation = event_row.next_generation
                  JOIN chat_heartbeat_occurrences occurrence
                    ON occurrence.admission_id = OLD.admission_id
                  WHERE left(event_row.idempotency_key, 18) = 'heartbeat-preempt_'
                    /* heartbeat preemption terminal timestamp evidence */
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
                    AND event_row.created_at = NEW.closed_at
                    AND successor.is_current = 1
                    AND successor.owner_kind = 'operator'
                    AND successor.lease_state = 'operator_active'
                    AND successor.transition_idempotency_key = event_row.idempotency_key
                    AND successor.transition_request_sha256 = event_row.request_sha256
                    AND successor.created_at = event_row.created_at
                    AND successor.updated_at = event_row.created_at
                    AND occurrence.workspace_id = OLD.workspace_id
                    AND occurrence.session_id = OLD.session_id
                    AND occurrence.controller_generation = OLD.controller_generation
                    AND occurrence.state IN ('admitted', 'durable_bound')
                    AND OLD.actor_kind = 'system'
                    AND OLD.actor_id = 'system-heartbeat'
                    AND OLD.operation = 'chat_system_heartbeat'
                    AND ((occurrence.state = 'admitted'
                      AND NEW.terminal_authority_kind = 'request_runtime'
                      AND NEW.terminal_control_event_id IS NULL
                      AND NEW.terminal_correlation_id = event_row.event_id)
                    OR (occurrence.state = 'durable_bound'
                      AND NEW.terminal_authority_kind = 'authority_superseded'
                      AND NEW.terminal_control_event_id = event_row.event_id))
                    AND NOT EXISTS (
                      SELECT 1 FROM chat_session_control_requests request_row
                      WHERE request_row.workspace_id = event_row.workspace_id
                        AND request_row.session_id = event_row.session_id
                        AND request_row.requested_generation = event_row.previous_generation
                        AND request_row.status = 'pending'
                    )
                )
              )$heartbeat_terminal_clock_evidence$;
      BEGIN
        SELECT pg_get_functiondef(to_regprocedure('gc_session_mutation_admission_guard()')) INTO function_sql;
        IF function_sql IS NULL THEN
          RAISE EXCEPTION 'Postgres migration 116 requires the mutation-admission guard'
            USING ERRCODE = '23514';
        END IF;
        IF strpos(function_sql, 'heartbeat occurrence request-runtime reclaim') = 0 THEN
          IF strpos(function_sql, anchor) = 0 THEN
            RAISE EXCEPTION 'Postgres migration 116 could not locate the mutation-admission guard upgrade anchor'
              USING ERRCODE = '23514';
          END IF;
          function_sql := replace(function_sql, anchor, replacement || anchor);
        END IF;
        IF strpos(function_sql, 'heartbeat occurrence durable-terminal zero-effect handoff') = 0 THEN
          IF strpos(function_sql, terminal_effects_anchor) = 0 THEN
            RAISE EXCEPTION 'Postgres migration 116 could not locate the durable-terminal effects guard anchor'
              USING ERRCODE = '23514';
          END IF;
          function_sql := replace(function_sql, terminal_effects_anchor, terminal_effects_replacement);
        END IF;
        IF strpos(function_sql, 'heartbeat preemption terminal timestamp evidence') = 0 THEN
          IF strpos(function_sql, terminal_clock_anchor) = 0 THEN
            RAISE EXCEPTION 'Postgres migration 116 could not locate the terminal clock guard anchor'
              USING ERRCODE = '23514';
          END IF;
          function_sql := replace(function_sql, terminal_clock_anchor, terminal_clock_replacement);
        END IF;
        EXECUTE function_sql;
        SELECT pg_get_functiondef(to_regprocedure('gc_session_mutation_admission_guard()')) INTO function_sql;
        IF strpos(function_sql, 'heartbeat occurrence request-runtime reclaim') = 0
          OR strpos(function_sql, 'heartbeat occurrence durable-terminal zero-effect handoff') = 0
          OR strpos(function_sql, 'heartbeat preemption terminal timestamp evidence') = 0 THEN
          RAISE EXCEPTION 'Postgres migration 116 mutation-admission guard upgrade assertion failed'
            USING ERRCODE = '23514';
        END IF;
      END;
      $heartbeat_admission_reclaim_guard_upgrade$;

      DO $heartbeat_profile_fk_preflight$
      BEGIN
        LOCK TABLE chat_turn_capability_profile_incarnation_bindings IN SHARE ROW EXCLUSIVE MODE;
        LOCK TABLE chat_turn_capability_profiles IN SHARE MODE;
        IF EXISTS (
          SELECT 1
          FROM chat_turn_capability_profile_incarnation_bindings binding
          LEFT JOIN chat_turn_capability_profiles profile ON profile.profile_id = binding.profile_id
          WHERE profile.profile_id IS NULL
        ) THEN
          RAISE EXCEPTION 'heartbeat profile binding FK repair orphan preflight failed' USING ERRCODE = '23514';
        END IF;
      END;
      $heartbeat_profile_fk_preflight$;

      DO $heartbeat_profile_fk_repair$
      DECLARE source_attnum SMALLINT;
      DECLARE target_attnum SMALLINT;
      DECLARE constraint_row RECORD;
      DECLARE mapping_count INTEGER;
      DECLARE good_count INTEGER;
      BEGIN
        SELECT attnum::SMALLINT INTO source_attnum
        FROM pg_attribute
        WHERE attrelid = to_regclass('chat_turn_capability_profile_incarnation_bindings')
          AND attname = 'profile_id' AND NOT attisdropped;
        SELECT attnum::SMALLINT INTO target_attnum
        FROM pg_attribute
        WHERE attrelid = to_regclass('chat_turn_capability_profiles')
          AND attname = 'profile_id' AND NOT attisdropped;
        IF source_attnum IS NULL OR target_attnum IS NULL THEN
          RAISE EXCEPTION 'heartbeat profile binding FK repair catalog preflight failed' USING ERRCODE = '23514';
        END IF;
        FOR constraint_row IN
          SELECT constraint_def.conname
          FROM pg_constraint constraint_def
          WHERE constraint_def.contype = 'f'
            AND constraint_def.conrelid = to_regclass('chat_turn_capability_profile_incarnation_bindings')
            AND constraint_def.confrelid = to_regclass('chat_turn_capability_profiles')
            AND constraint_def.conkey = ARRAY[source_attnum]::SMALLINT[]
            AND constraint_def.confkey = ARRAY[target_attnum]::SMALLINT[]
        LOOP
          EXECUTE format(
            'ALTER TABLE chat_turn_capability_profile_incarnation_bindings DROP CONSTRAINT %I',
            constraint_row.conname
          );
        END LOOP;
        EXECUTE 'ALTER TABLE chat_turn_capability_profile_incarnation_bindings
          ADD CONSTRAINT fk_chat_turn_cap_profile_binding_profile
          FOREIGN KEY(profile_id) REFERENCES chat_turn_capability_profiles(profile_id)
          ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED';
        SELECT COUNT(*) INTO mapping_count
        FROM pg_constraint constraint_def
        WHERE constraint_def.contype = 'f'
          AND constraint_def.conrelid = to_regclass('chat_turn_capability_profile_incarnation_bindings')
          AND constraint_def.confrelid = to_regclass('chat_turn_capability_profiles')
          AND constraint_def.conkey = ARRAY[source_attnum]::SMALLINT[]
          AND constraint_def.confkey = ARRAY[target_attnum]::SMALLINT[];
        SELECT COUNT(*) INTO good_count
        FROM pg_constraint constraint_def
        WHERE constraint_def.contype = 'f'
          AND constraint_def.conrelid = to_regclass('chat_turn_capability_profile_incarnation_bindings')
          AND constraint_def.confrelid = to_regclass('chat_turn_capability_profiles')
          AND constraint_def.conkey = ARRAY[source_attnum]::SMALLINT[]
          AND constraint_def.confkey = ARRAY[target_attnum]::SMALLINT[]
          AND constraint_def.conname = 'fk_chat_turn_cap_profile_binding_profile'
          AND constraint_def.condeferrable AND constraint_def.condeferred AND constraint_def.convalidated
          AND constraint_def.confdeltype = 'a' AND constraint_def.confupdtype = 'a';
        IF mapping_count <> 1 OR good_count <> 1 THEN
          RAISE EXCEPTION 'heartbeat profile binding FK repair catalog assertion failed' USING ERRCODE = '23514';
        END IF;
      END;
      $heartbeat_profile_fk_repair$;
    `,
  },
  {
    version: 117,
    name: "governed_lifecycle_foundation",
    // HX-402 P0 shared immutable lifecycle foundation (paired with SQLite 175).
    // Additive only: five new append-only tables, the frozen governed-mutation
    // kind registry guard, claim/inspection/settlement fencing, and
    // no-update/no-delete triggers. The kind rows are a FROZEN literal copy of
    // GOVERNED_MUTATION_KINDS in @goatcitadel/contracts; the
    // journey-producer-schema-parity suite proves the copy stays aligned with
    // the contract and the SQLite twin. Extending the registry requires a NEW
    // migration pair.
    sql: `
      CREATE TABLE IF NOT EXISTS governed_lifecycle_events (
        schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.governed-lifecycle-event.v1'),
        event_id TEXT PRIMARY KEY CHECK(length(TRIM(event_id)) BETWEEN 1 AND 256),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(TRIM(idempotency_key)) BETWEEN 1 AND 512),
        domain TEXT NOT NULL CHECK(domain IN ('memory', 'skill_state', 'capability_state', 'improvement')),
        operation TEXT NOT NULL CHECK(length(TRIM(operation)) BETWEEN 1 AND 128),
        target_kind TEXT NOT NULL CHECK(length(TRIM(target_kind)) BETWEEN 1 AND 128),
        target_id TEXT NOT NULL CHECK(length(TRIM(target_id)) BETWEEN 1 AND 256),
        material_sha256 TEXT NOT NULL CHECK(material_sha256 ~ '^[0-9a-f]{64}$'),
        scope_kind TEXT NOT NULL CHECK(scope_kind IN ('workspace', 'global')),
        workspace_id TEXT,
        actor_id TEXT NOT NULL CHECK(length(TRIM(actor_id)) BETWEEN 1 AND 256),
        actor_type TEXT NOT NULL CHECK(actor_type IN ('operator', 'system', 'approval_effect')),
        session_id TEXT CHECK(session_id IS NULL OR length(TRIM(session_id)) BETWEEN 1 AND 256),
        turn_id TEXT CHECK(turn_id IS NULL OR length(TRIM(turn_id)) BETWEEN 1 AND 256),
        source_required BIGINT NOT NULL CHECK(source_required IN (0, 1)),
        approval_required BIGINT NOT NULL CHECK(approval_required IN (0, 1)),
        source_kind TEXT CHECK(source_kind IS NULL OR length(TRIM(source_kind)) BETWEEN 1 AND 128),
        source_id TEXT CHECK(source_id IS NULL OR length(TRIM(source_id)) BETWEEN 1 AND 256),
        approval_id TEXT CHECK(approval_id IS NULL OR length(TRIM(approval_id)) BETWEEN 1 AND 256),
        occurred_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(occurred_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = occurred_at
        ),
        recorded_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(recorded_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(recorded_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = recorded_at
        ),
        CHECK(
          (scope_kind = 'workspace' AND workspace_id IS NOT NULL AND length(TRIM(workspace_id)) BETWEEN 1 AND 256)
          OR (scope_kind = 'global' AND workspace_id IS NULL)
        ),
        CHECK(turn_id IS NULL OR session_id IS NOT NULL),
        CHECK(
          (approval_required = 1 AND approval_id IS NOT NULL)
          OR (approval_required = 0 AND approval_id IS NULL)
        ),
        CHECK(source_required = 0 OR (source_kind IS NOT NULL AND source_id IS NOT NULL)),
        CHECK(
          (source_kind IS NULL AND source_id IS NULL)
          OR (source_kind IS NOT NULL AND source_id IS NOT NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_governed_lifecycle_events_scope_recorded
        ON governed_lifecycle_events(workspace_id, recorded_at DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS idx_governed_lifecycle_events_target
        ON governed_lifecycle_events(domain, target_kind, target_id, recorded_at DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS idx_governed_lifecycle_events_approval
        ON governed_lifecycle_events(approval_id);

      CREATE OR REPLACE FUNCTION gc_governed_lifecycle_event_kind_guard() RETURNS TRIGGER AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM (VALUES
            ('memory', 'item_updated', 'memory_item', 1, 1, 0),
            ('memory', 'pin_changed', 'memory_item', 1, 1, 0),
            ('memory', 'ttl_changed', 'memory_item', 1, 1, 0),
            ('memory', 'item_forgotten', 'memory_item', 1, 1, 0),
            ('memory', 'batch_mutated', 'memory_batch', 1, 1, 0),
            ('memory', 'maintenance_expired', 'memory_item', 1, 0, 1),
            ('memory', 'entity_created', 'memory_entity', 1, 1, 0),
            ('memory', 'entity_forgotten', 'memory_entity', 1, 1, 0),
            ('memory', 'relation_created', 'memory_relation', 1, 1, 0),
            ('memory', 'decision_created', 'memory_decision', 1, 1, 0),
            ('memory', 'decision_retrospective_added', 'memory_decision', 1, 1, 0),
            ('memory', 'decision_forgotten', 'memory_decision', 1, 1, 0),
            ('memory', 'learning_created', 'memory_learning', 1, 1, 0),
            ('memory', 'learning_superseded', 'memory_learning', 1, 1, 0),
            ('memory', 'learning_forgotten', 'memory_learning', 1, 1, 0),
            ('memory', 'trace_candidate_promoted', 'memory_learning', 1, 1, 0),
            ('memory', 'session_learned_updated', 'session_learned_memory', 1, 1, 0),
            ('skill_state', 'enabled', 'skill', 1, 1, 0),
            ('skill_state', 'disabled', 'skill', 1, 1, 0),
            ('skill_state', 'slept', 'skill', 1, 1, 0),
            ('skill_state', 'auto_set', 'skill', 1, 1, 0),
            ('skill_state', 'activation_policy_updated', 'skill_activation_policy', 1, 1, 0),
            ('skill_state', 'system_disabled', 'skill', 1, 0, 1),
            ('capability_state', 'proposal_created', 'capability_proposal', 1, 0, 0),
            ('capability_state', 'candidate_promoted', 'capability_candidate', 1, 1, 0),
            ('capability_state', 'candidate_revoked', 'capability_candidate', 1, 1, 0),
            ('capability_state', 'candidate_rolled_back', 'capability_candidate', 1, 1, 0),
            ('capability_state', 'system_revoked', 'capability_candidate', 1, 0, 1),
            ('improvement', 'activation_applied', 'improvement_activation', 1, 1, 0),
            ('improvement', 'activation_paused', 'improvement_activation', 1, 1, 0),
            ('improvement', 'activation_rolled_back', 'improvement_activation', 1, 1, 0),
            ('improvement', 'activation_failed', 'improvement_activation', 1, 1, 0)
          ) AS kind_registry(domain, operation, target_kind, source_required, approval_required, system_actor_only)
          WHERE kind_registry.domain = NEW.domain
            AND kind_registry.operation = NEW.operation
            AND kind_registry.target_kind = NEW.target_kind
            AND kind_registry.source_required = NEW.source_required
            AND kind_registry.approval_required = NEW.approval_required
            AND (kind_registry.system_actor_only = 0 OR NEW.actor_type = 'system')
        ) THEN
          RAISE EXCEPTION 'governed lifecycle event kind is not in the frozen registry' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_reject_governed_lifecycle_mutation() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'governed lifecycle records are immutable (no update, no delete)' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_governed_lifecycle_events_kind_guard ON governed_lifecycle_events;
      CREATE TRIGGER trg_governed_lifecycle_events_kind_guard
        BEFORE INSERT ON governed_lifecycle_events
        FOR EACH ROW EXECUTE FUNCTION gc_governed_lifecycle_event_kind_guard();
      DROP TRIGGER IF EXISTS trg_governed_lifecycle_events_no_update ON governed_lifecycle_events;
      CREATE TRIGGER trg_governed_lifecycle_events_no_update
        BEFORE UPDATE ON governed_lifecycle_events
        FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_lifecycle_mutation();
      DROP TRIGGER IF EXISTS trg_governed_lifecycle_events_no_delete ON governed_lifecycle_events;
      CREATE TRIGGER trg_governed_lifecycle_events_no_delete
        BEFORE DELETE ON governed_lifecycle_events
        FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_lifecycle_mutation();

      CREATE TABLE IF NOT EXISTS improvement_lifecycle_operations (
        operation_id TEXT PRIMARY KEY CHECK(length(TRIM(operation_id)) BETWEEN 1 AND 256),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(length(TRIM(idempotency_key)) BETWEEN 1 AND 512),
        workspace_id TEXT NOT NULL CHECK(length(TRIM(workspace_id)) BETWEEN 1 AND 256),
        operation_kind TEXT NOT NULL CHECK(operation_kind IN ('activate', 'pause', 'rollback')),
        target_kind TEXT NOT NULL CHECK(target_kind IN ('improvement_activation', 'improvement_candidate')),
        target_id TEXT NOT NULL CHECK(length(TRIM(target_id)) BETWEEN 1 AND 256),
        approval_id TEXT NOT NULL UNIQUE CHECK(length(TRIM(approval_id)) BETWEEN 1 AND 256),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        actor_id TEXT NOT NULL CHECK(length(TRIM(actor_id)) BETWEEN 1 AND 256),
        session_id TEXT CHECK(session_id IS NULL OR length(TRIM(session_id)) BETWEEN 1 AND 256),
        turn_id TEXT CHECK(turn_id IS NULL OR length(TRIM(turn_id)) BETWEEN 1 AND 256),
        created_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(created_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = created_at
        ),
        CHECK(turn_id IS NULL OR session_id IS NOT NULL)
      );

      CREATE INDEX IF NOT EXISTS idx_improvement_lifecycle_operations_workspace_created
        ON improvement_lifecycle_operations(workspace_id, created_at DESC, operation_id DESC);
      CREATE INDEX IF NOT EXISTS idx_improvement_lifecycle_operations_target
        ON improvement_lifecycle_operations(target_kind, target_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS improvement_lifecycle_operation_claims (
        operation_id TEXT NOT NULL REFERENCES improvement_lifecycle_operations(operation_id) ON DELETE RESTRICT,
        claim_generation BIGINT NOT NULL CHECK(claim_generation > 0),
        worker_id TEXT NOT NULL CHECK(length(TRIM(worker_id)) BETWEEN 1 AND 256),
        claimed_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(claimed_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(claimed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = claimed_at
        ),
        lease_expires_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(lease_expires_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(lease_expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = lease_expires_at
        ),
        PRIMARY KEY(operation_id, claim_generation),
        CHECK(lease_expires_at > claimed_at)
      );

      CREATE TABLE IF NOT EXISTS improvement_lifecycle_operation_inspections (
        inspection_id TEXT PRIMARY KEY CHECK(length(TRIM(inspection_id)) BETWEEN 1 AND 256),
        operation_id TEXT NOT NULL,
        claim_generation BIGINT NOT NULL CHECK(claim_generation > 0),
        observed_state_sha256 TEXT NOT NULL CHECK(observed_state_sha256 ~ '^[0-9a-f]{64}$'),
        disposition TEXT NOT NULL CHECK(disposition IN ('matches_intent', 'diverged', 'unreachable')),
        observed_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(observed_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(observed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = observed_at
        ),
        FOREIGN KEY(operation_id, claim_generation)
          REFERENCES improvement_lifecycle_operation_claims(operation_id, claim_generation) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_improvement_lifecycle_operation_inspections_operation
        ON improvement_lifecycle_operation_inspections(operation_id, claim_generation, observed_at DESC);

      CREATE TABLE IF NOT EXISTS improvement_lifecycle_operation_settlements (
        settlement_id TEXT PRIMARY KEY CHECK(length(TRIM(settlement_id)) BETWEEN 1 AND 256),
        operation_id TEXT NOT NULL UNIQUE REFERENCES improvement_lifecycle_operations(operation_id) ON DELETE RESTRICT,
        claim_generation BIGINT NOT NULL CHECK(claim_generation > 0),
        inspection_id TEXT NOT NULL UNIQUE
          REFERENCES improvement_lifecycle_operation_inspections(inspection_id) ON DELETE RESTRICT,
        disposition TEXT NOT NULL CHECK(disposition IN ('applied', 'failed', 'aborted')),
        observed_state_sha256 TEXT NOT NULL CHECK(observed_state_sha256 ~ '^[0-9a-f]{64}$'),
        result_json TEXT NOT NULL CHECK(octet_length(result_json) <= 16384),
        result_sha256 TEXT NOT NULL CHECK(result_sha256 ~ '^[0-9a-f]{64}$'),
        settled_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(settled_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(settled_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = settled_at
        ),
        FOREIGN KEY(operation_id, claim_generation)
          REFERENCES improvement_lifecycle_operation_claims(operation_id, claim_generation) ON DELETE RESTRICT
      );

      CREATE OR REPLACE FUNCTION gc_improvement_lifecycle_claim_guard() RETURNS TRIGGER AS $$
      DECLARE
        database_now TIMESTAMPTZ := clock_timestamp();
        expected_generation BIGINT;
        prior_lease TEXT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operation_id, 402));
        IF EXISTS (
          SELECT 1 FROM improvement_lifecycle_operation_settlements settlement
          WHERE settlement.operation_id = NEW.operation_id
        ) THEN
          RAISE EXCEPTION 'improvement lifecycle claim admission violated: operation already settled' USING ERRCODE = '23514';
        END IF;
        SELECT COALESCE(MAX(prior.claim_generation), 0) + 1 INTO expected_generation
        FROM improvement_lifecycle_operation_claims prior
        WHERE prior.operation_id = NEW.operation_id;
        IF NEW.claim_generation <> expected_generation THEN
          RAISE EXCEPTION 'improvement lifecycle claim admission violated: non-sequential claim generation' USING ERRCODE = '23514';
        END IF;
        SELECT prior.lease_expires_at INTO prior_lease
        FROM improvement_lifecycle_operation_claims prior
        WHERE prior.operation_id = NEW.operation_id
          AND prior.claim_generation = NEW.claim_generation - 1;
        IF prior_lease IS NOT NULL AND gc_try_parse_timestamptz(prior_lease) > database_now THEN
          RAISE EXCEPTION 'improvement lifecycle claim admission violated: prior claim lease is still live' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_improvement_lifecycle_inspection_guard() RETURNS TRIGGER AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operation_id, 402));
        IF EXISTS (
          SELECT 1 FROM improvement_lifecycle_operation_settlements settlement
          WHERE settlement.operation_id = NEW.operation_id
        ) THEN
          RAISE EXCEPTION 'improvement lifecycle inspection admission violated: operation already settled' USING ERRCODE = '23514';
        END IF;
        IF NEW.claim_generation IS DISTINCT FROM (
          SELECT MAX(claim.claim_generation)
          FROM improvement_lifecycle_operation_claims claim
          WHERE claim.operation_id = NEW.operation_id
        ) THEN
          RAISE EXCEPTION 'improvement lifecycle inspection admission violated: fenced stale claim' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_improvement_lifecycle_settlement_guard() RETURNS TRIGGER AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operation_id, 402));
        IF NEW.claim_generation IS DISTINCT FROM (
          SELECT MAX(claim.claim_generation)
          FROM improvement_lifecycle_operation_claims claim
          WHERE claim.operation_id = NEW.operation_id
        ) THEN
          RAISE EXCEPTION 'improvement lifecycle settlement admission violated: fenced stale claim' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM improvement_lifecycle_operation_inspections inspection
          WHERE inspection.inspection_id = NEW.inspection_id
            AND inspection.operation_id = NEW.operation_id
            AND inspection.claim_generation = NEW.claim_generation
            AND inspection.observed_state_sha256 = NEW.observed_state_sha256
        ) THEN
          RAISE EXCEPTION 'improvement lifecycle settlement admission violated: missing exact same-claim re-inspection' USING ERRCODE = '23514';
        END IF;
        IF NEW.disposition = 'applied' AND NOT EXISTS (
          SELECT 1 FROM improvement_lifecycle_operation_inspections inspection
          WHERE inspection.inspection_id = NEW.inspection_id
            AND inspection.disposition = 'matches_intent'
        ) THEN
          RAISE EXCEPTION 'improvement lifecycle settlement admission violated: false applied claim' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_improvement_lifecycle_operations_no_update ON improvement_lifecycle_operations;
      CREATE TRIGGER trg_improvement_lifecycle_operations_no_update
        BEFORE UPDATE ON improvement_lifecycle_operations
        FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_lifecycle_mutation();
      DROP TRIGGER IF EXISTS trg_improvement_lifecycle_operations_no_delete ON improvement_lifecycle_operations;
      CREATE TRIGGER trg_improvement_lifecycle_operations_no_delete
        BEFORE DELETE ON improvement_lifecycle_operations
        FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_lifecycle_mutation();

      DROP TRIGGER IF EXISTS trg_improvement_lifecycle_operation_claims_insert_guard ON improvement_lifecycle_operation_claims;
      CREATE TRIGGER trg_improvement_lifecycle_operation_claims_insert_guard
        BEFORE INSERT ON improvement_lifecycle_operation_claims
        FOR EACH ROW EXECUTE FUNCTION gc_improvement_lifecycle_claim_guard();
      DROP TRIGGER IF EXISTS trg_improvement_lifecycle_operation_claims_no_update ON improvement_lifecycle_operation_claims;
      CREATE TRIGGER trg_improvement_lifecycle_operation_claims_no_update
        BEFORE UPDATE ON improvement_lifecycle_operation_claims
        FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_lifecycle_mutation();
      DROP TRIGGER IF EXISTS trg_improvement_lifecycle_operation_claims_no_delete ON improvement_lifecycle_operation_claims;
      CREATE TRIGGER trg_improvement_lifecycle_operation_claims_no_delete
        BEFORE DELETE ON improvement_lifecycle_operation_claims
        FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_lifecycle_mutation();

      DROP TRIGGER IF EXISTS trg_improvement_lifecycle_operation_inspections_insert_guard ON improvement_lifecycle_operation_inspections;
      CREATE TRIGGER trg_improvement_lifecycle_operation_inspections_insert_guard
        BEFORE INSERT ON improvement_lifecycle_operation_inspections
        FOR EACH ROW EXECUTE FUNCTION gc_improvement_lifecycle_inspection_guard();
      DROP TRIGGER IF EXISTS trg_improvement_lifecycle_operation_inspections_no_update ON improvement_lifecycle_operation_inspections;
      CREATE TRIGGER trg_improvement_lifecycle_operation_inspections_no_update
        BEFORE UPDATE ON improvement_lifecycle_operation_inspections
        FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_lifecycle_mutation();
      DROP TRIGGER IF EXISTS trg_improvement_lifecycle_operation_inspections_no_delete ON improvement_lifecycle_operation_inspections;
      CREATE TRIGGER trg_improvement_lifecycle_operation_inspections_no_delete
        BEFORE DELETE ON improvement_lifecycle_operation_inspections
        FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_lifecycle_mutation();

      DROP TRIGGER IF EXISTS trg_improvement_lifecycle_operation_settlements_insert_guard ON improvement_lifecycle_operation_settlements;
      CREATE TRIGGER trg_improvement_lifecycle_operation_settlements_insert_guard
        BEFORE INSERT ON improvement_lifecycle_operation_settlements
        FOR EACH ROW EXECUTE FUNCTION gc_improvement_lifecycle_settlement_guard();
      DROP TRIGGER IF EXISTS trg_improvement_lifecycle_operation_settlements_no_update ON improvement_lifecycle_operation_settlements;
      CREATE TRIGGER trg_improvement_lifecycle_operation_settlements_no_update
        BEFORE UPDATE ON improvement_lifecycle_operation_settlements
        FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_lifecycle_mutation();
      DROP TRIGGER IF EXISTS trg_improvement_lifecycle_operation_settlements_no_delete ON improvement_lifecycle_operation_settlements;
      CREATE TRIGGER trg_improvement_lifecycle_operation_settlements_no_delete
        BEFORE DELETE ON improvement_lifecycle_operation_settlements
        FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_lifecycle_mutation();
    `,
  },
  {
    version: 118,
    name: "remote_worker_request_nonce_authority",
    // HX-501B1 durable request-nonce consumption owner (paired with SQLite 176).
    // Additive only: two new authority-specific, hash-only tables and the two
    // minimal parent UNIQUE keys their complete composite foreign keys require.
    // The only frozen-table change is ADD CONSTRAINT ... UNIQUE on the admission
    // parents (PostgreSQL foreign keys require a unique CONSTRAINT, not a bare
    // index); no column is altered and no row is written. The raw nonce never
    // has a column; only the nonce digest, request timestamp, database
    // consumption timestamp, and expiry are stored. Production-dark: no route,
    // listener, startup, assignment, inference, cell, or UI owner.
    sql: `
      ALTER TABLE remote_worker_bootstrap_requests
        ADD CONSTRAINT uq_remote_worker_bootstrap_requests_nonce_authority
        UNIQUE (registry_workspace_id, bootstrap_id, worker_id, target_worker_generation);
      ALTER TABLE remote_worker_runtime_credentials
        ADD CONSTRAINT uq_remote_worker_runtime_credentials_nonce_authority
        UNIQUE (registry_workspace_id, worker_id, worker_generation, credential_generation, credential_id);

      CREATE TABLE IF NOT EXISTS remote_worker_bootstrap_request_nonces (
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
        target_worker_generation BIGINT NOT NULL CHECK(target_worker_generation > 0),
        bootstrap_id TEXT NOT NULL CHECK(length(bootstrap_id) BETWEEN 1 AND 256),
        nonce_sha256 TEXT NOT NULL CHECK(nonce_sha256 ~ '^[0-9a-f]{64}$'),
        request_timestamp TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(request_timestamp) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(request_timestamp) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = request_timestamp
        ),
        consumed_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(consumed_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(consumed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = consumed_at
        ),
        expires_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(expires_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = expires_at
        ),
        PRIMARY KEY(registry_workspace_id, worker_id, target_worker_generation, bootstrap_id, nonce_sha256),
        FOREIGN KEY(registry_workspace_id, bootstrap_id, worker_id, target_worker_generation)
          REFERENCES remote_worker_bootstrap_requests(
            registry_workspace_id, bootstrap_id, worker_id, target_worker_generation
          ) ON DELETE RESTRICT,
        CHECK(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(expires_at) - gc_try_parse_timestamptz(request_timestamp))) = 60)
      );

      CREATE TABLE IF NOT EXISTS remote_worker_credential_request_nonces (
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
        worker_generation BIGINT NOT NULL CHECK(worker_generation > 0),
        credential_generation BIGINT NOT NULL CHECK(credential_generation > 0),
        credential_id TEXT NOT NULL CHECK(length(credential_id) BETWEEN 1 AND 256),
        nonce_sha256 TEXT NOT NULL CHECK(nonce_sha256 ~ '^[0-9a-f]{64}$'),
        request_timestamp TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(request_timestamp) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(request_timestamp) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = request_timestamp
        ),
        consumed_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(consumed_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(consumed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = consumed_at
        ),
        expires_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(expires_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = expires_at
        ),
        PRIMARY KEY(registry_workspace_id, worker_id, worker_generation, credential_generation, credential_id, nonce_sha256),
        FOREIGN KEY(registry_workspace_id, worker_id, worker_generation, credential_generation, credential_id)
          REFERENCES remote_worker_runtime_credentials(
            registry_workspace_id, worker_id, worker_generation, credential_generation, credential_id
          ) ON DELETE RESTRICT,
        CHECK(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(expires_at) - gc_try_parse_timestamptz(request_timestamp))) = 60)
      );

      CREATE INDEX IF NOT EXISTS idx_remote_worker_bootstrap_request_nonces_expiry
        ON remote_worker_bootstrap_request_nonces(
          expires_at, registry_workspace_id, worker_id, target_worker_generation, bootstrap_id, nonce_sha256
        );
      CREATE INDEX IF NOT EXISTS idx_remote_worker_credential_request_nonces_expiry
        ON remote_worker_credential_request_nonces(
          expires_at, registry_workspace_id, worker_id, worker_generation, credential_generation, credential_id, nonce_sha256
        );

      CREATE OR REPLACE FUNCTION gc_remote_worker_bootstrap_request_nonce_guard()
      RETURNS trigger AS $$
      DECLARE database_now TIMESTAMPTZ := clock_timestamp();
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id, 501));
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id || ':' || NEW.worker_id, 502));
        IF gc_try_parse_timestamptz(NEW.request_timestamp) IS NULL
          OR to_char(gc_try_parse_timestamptz(NEW.request_timestamp) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> NEW.request_timestamp
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.request_timestamp) - database_now))) > 60
          OR gc_try_parse_timestamptz(NEW.expires_at) <= database_now THEN
          RAISE EXCEPTION 'remote worker bootstrap nonce authority is outside the request window' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM remote_worker_bootstrap_requests bootstrap
          WHERE bootstrap.registry_workspace_id = NEW.registry_workspace_id
            AND bootstrap.bootstrap_id = NEW.bootstrap_id
            AND bootstrap.worker_id = NEW.worker_id
            AND bootstrap.target_worker_generation = NEW.target_worker_generation
            AND gc_try_parse_timestamptz(bootstrap.expires_at) > database_now
        ) THEN
          RAISE EXCEPTION 'remote worker bootstrap nonce authority is expired or unknown' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
          SELECT 1 FROM remote_worker_generations generation
          WHERE generation.registry_workspace_id = NEW.registry_workspace_id
            AND generation.bootstrap_id = NEW.bootstrap_id
        ) THEN
          RAISE EXCEPTION 'remote worker bootstrap nonce authority is already consumed' USING ERRCODE = '23514';
        END IF;
        IF NEW.target_worker_generation <> (
          SELECT COALESCE(MAX(generation.worker_generation), 0) + 1
          FROM remote_worker_generations generation
          WHERE generation.registry_workspace_id = NEW.registry_workspace_id
            AND generation.worker_id = NEW.worker_id
        ) THEN
          RAISE EXCEPTION 'remote worker bootstrap nonce target generation is not current' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_remote_worker_credential_request_nonce_guard()
      RETURNS trigger AS $$
      DECLARE database_now TIMESTAMPTZ := clock_timestamp();
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id, 501));
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id || ':' || NEW.worker_id, 502));
        IF gc_try_parse_timestamptz(NEW.request_timestamp) IS NULL
          OR to_char(gc_try_parse_timestamptz(NEW.request_timestamp) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> NEW.request_timestamp
          OR abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.request_timestamp) - database_now))) > 60
          OR gc_try_parse_timestamptz(NEW.expires_at) <= database_now THEN
          RAISE EXCEPTION 'remote worker credential nonce authority is outside the request window' USING ERRCODE = '23514';
        END IF;
        IF NEW.worker_generation <> (
          SELECT MAX(generation.worker_generation)
          FROM remote_worker_generations generation
          WHERE generation.registry_workspace_id = NEW.registry_workspace_id
            AND generation.worker_id = NEW.worker_id
        ) THEN
          RAISE EXCEPTION 'remote worker credential nonce worker generation is not latest' USING ERRCODE = '23514';
        END IF;
        IF NEW.credential_generation <> (
          SELECT MAX(credential.credential_generation)
          FROM remote_worker_runtime_credentials credential
          WHERE credential.registry_workspace_id = NEW.registry_workspace_id
            AND credential.worker_id = NEW.worker_id
            AND credential.worker_generation = NEW.worker_generation
        ) THEN
          RAISE EXCEPTION 'remote worker credential nonce credential generation is not latest' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM remote_worker_runtime_credentials credential
          WHERE credential.registry_workspace_id = NEW.registry_workspace_id
            AND credential.worker_id = NEW.worker_id
            AND credential.worker_generation = NEW.worker_generation
            AND credential.credential_generation = NEW.credential_generation
            AND credential.credential_id = NEW.credential_id
            AND gc_try_parse_timestamptz(credential.expires_at) > database_now
        ) THEN
          RAISE EXCEPTION 'remote worker credential nonce authority is expired or unknown' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
          SELECT 1 FROM remote_worker_generation_controls control
          WHERE control.registry_workspace_id = NEW.registry_workspace_id
            AND control.worker_id = NEW.worker_id
            AND control.worker_generation = NEW.worker_generation
        ) THEN
          RAISE EXCEPTION 'remote worker credential nonce authority is quarantined or revoked' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_reject_remote_worker_request_nonce_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'remote worker request nonces are immutable (no update)' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_remote_worker_request_nonce_delete_guard()
      RETURNS trigger AS $$
      BEGIN
        IF gc_try_parse_timestamptz(OLD.expires_at) > clock_timestamp() THEN
          RAISE EXCEPTION 'live remote worker request nonces are undeletable' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_remote_worker_bootstrap_request_nonces_insert_guard ON remote_worker_bootstrap_request_nonces;
      CREATE TRIGGER trg_remote_worker_bootstrap_request_nonces_insert_guard
        BEFORE INSERT ON remote_worker_bootstrap_request_nonces
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_bootstrap_request_nonce_guard();
      DROP TRIGGER IF EXISTS trg_remote_worker_bootstrap_request_nonces_no_update ON remote_worker_bootstrap_request_nonces;
      CREATE TRIGGER trg_remote_worker_bootstrap_request_nonces_no_update
        BEFORE UPDATE ON remote_worker_bootstrap_request_nonces
        FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_request_nonce_mutation();
      DROP TRIGGER IF EXISTS trg_remote_worker_bootstrap_request_nonces_no_delete ON remote_worker_bootstrap_request_nonces;
      CREATE TRIGGER trg_remote_worker_bootstrap_request_nonces_no_delete
        BEFORE DELETE ON remote_worker_bootstrap_request_nonces
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_request_nonce_delete_guard();

      DROP TRIGGER IF EXISTS trg_remote_worker_credential_request_nonces_insert_guard ON remote_worker_credential_request_nonces;
      CREATE TRIGGER trg_remote_worker_credential_request_nonces_insert_guard
        BEFORE INSERT ON remote_worker_credential_request_nonces
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_credential_request_nonce_guard();
      DROP TRIGGER IF EXISTS trg_remote_worker_credential_request_nonces_no_update ON remote_worker_credential_request_nonces;
      CREATE TRIGGER trg_remote_worker_credential_request_nonces_no_update
        BEFORE UPDATE ON remote_worker_credential_request_nonces
        FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_request_nonce_mutation();
      DROP TRIGGER IF EXISTS trg_remote_worker_credential_request_nonces_no_delete ON remote_worker_credential_request_nonces;
      CREATE TRIGGER trg_remote_worker_credential_request_nonces_no_delete
        BEFORE DELETE ON remote_worker_credential_request_nonces
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_request_nonce_delete_guard();
    `,
  },
  {
    version: 119,
    name: "remote_worker_inference_request_owner",
    // HX-503 assignment-bound inference request owner (paired with SQLite 177).
    // Additive only: two new tables bound by complete composite foreign keys to
    // the committed assignment-generation authority, whose PRIMARY KEY already
    // satisfies the reference, so no frozen table is altered and no row is
    // written. The raw assignment lease and every provider credential never has
    // a column; output frames are secret-free and append-only. Production-dark:
    // no route, listener, startup, scheduler, or accounting owner.
    integritySha256: "1db54aec0105b0cbb6382722d17956dc3ae213d25c4b5c856878c9abc881c91e",
    sql: `
      CREATE TABLE IF NOT EXISTS remote_worker_inference_requests (
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        assignment_id TEXT NOT NULL CHECK(length(assignment_id) BETWEEN 1 AND 256),
        assignment_generation BIGINT NOT NULL CHECK(assignment_generation > 0),
        inference_request_id TEXT NOT NULL CHECK(length(inference_request_id) BETWEEN 1 AND 256),
        attempt BIGINT NOT NULL CHECK(attempt > 0),
        worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
        worker_generation BIGINT NOT NULL CHECK(worker_generation > 0),
        session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
        turn_id TEXT NOT NULL CHECK(length(turn_id) BETWEEN 1 AND 256),
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_body_json TEXT NOT NULL CHECK(
          jsonb_typeof(request_body_json::jsonb) = 'object' AND octet_length(request_body_json) <= 1179648
        ),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        input_sha256 TEXT NOT NULL CHECK(input_sha256 ~ '^[0-9a-f]{64}$'),
        context_sha256 TEXT NOT NULL CHECK(context_sha256 ~ '^[0-9a-f]{64}$'),
        model_intent_sha256 TEXT NOT NULL CHECK(model_intent_sha256 ~ '^[0-9a-f]{64}$'),
        capability_profile_sha256 TEXT NOT NULL CHECK(capability_profile_sha256 ~ '^[0-9a-f]{64}$'),
        routed_context_sha256 TEXT NOT NULL CHECK(routed_context_sha256 ~ '^[0-9a-f]{64}$'),
        output_token_ceiling BIGINT NOT NULL CHECK(output_token_ceiling BETWEEN 1 AND 1000000),
        reasoning_token_ceiling BIGINT NOT NULL CHECK(reasoning_token_ceiling BETWEEN 0 AND 1000000),
        temperature_milli BIGINT NOT NULL CHECK(temperature_milli BETWEEN 0 AND 2000),
        operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 256),
        dispatch_generation TEXT NOT NULL CHECK(length(dispatch_generation) BETWEEN 1 AND 256),
        state TEXT NOT NULL CHECK(state IN (
          'admitted', 'waiting_approval', 'blocked', 'dispatch_claimed',
          'streaming', 'completed', 'failed', 'cancelled', 'dispatch_unknown'
        )),
        governance_decision TEXT NOT NULL CHECK(governance_decision IN ('allowed', 'approval_required', 'denied')),
        effective_route_sha256 TEXT NOT NULL CHECK(effective_route_sha256 ~ '^[0-9a-f]{64}$'),
        policy_revision BIGINT NOT NULL CHECK(policy_revision > 0),
        policy_sha256 TEXT NOT NULL CHECK(policy_sha256 ~ '^[0-9a-f]{64}$'),
        approval_receipt_sha256 TEXT CHECK(approval_receipt_sha256 IS NULL OR approval_receipt_sha256 ~ '^[0-9a-f]{64}$'),
        governance_output_token_ceiling BIGINT NOT NULL CHECK(governance_output_token_ceiling BETWEEN 1 AND 1000000),
        governance_reasoning_token_ceiling BIGINT NOT NULL CHECK(governance_reasoning_token_ceiling BETWEEN 0 AND 1000000),
        governance_expires_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(governance_expires_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(governance_expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = governance_expires_at
        ),
        budget_reservation_id TEXT NOT NULL CHECK(length(budget_reservation_id) BETWEEN 1 AND 256),
        effective_provider_id TEXT CHECK(effective_provider_id IS NULL OR length(effective_provider_id) BETWEEN 1 AND 256),
        effective_model_id TEXT CHECK(effective_model_id IS NULL OR length(effective_model_id) BETWEEN 1 AND 256),
        dispatch_claim_owner TEXT CHECK(dispatch_claim_owner IS NULL OR length(dispatch_claim_owner) BETWEEN 1 AND 256),
        dispatch_claimed_at TEXT CHECK(dispatch_claimed_at IS NULL OR (
          gc_try_parse_timestamptz(dispatch_claimed_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(dispatch_claimed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = dispatch_claimed_at
        )),
        dispatch_lease_expires_at TEXT CHECK(dispatch_lease_expires_at IS NULL OR (
          gc_try_parse_timestamptz(dispatch_lease_expires_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(dispatch_lease_expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = dispatch_lease_expires_at
        )),
        usage_intent_event_id TEXT CHECK(usage_intent_event_id IS NULL OR length(usage_intent_event_id) BETWEEN 1 AND 256),
        usage_terminal_event_id TEXT CHECK(usage_terminal_event_id IS NULL OR length(usage_terminal_event_id) BETWEEN 1 AND 256),
        output_frame_count BIGINT NOT NULL DEFAULT 0 CHECK(output_frame_count BETWEEN 0 AND 100000),
        output_char_count BIGINT NOT NULL DEFAULT 0 CHECK(output_char_count BETWEEN 0 AND 8388608),
        worker_acknowledged_through BIGINT NOT NULL DEFAULT 0 CHECK(worker_acknowledged_through BETWEEN 0 AND 100000),
        terminal_frame_sequence BIGINT CHECK(terminal_frame_sequence IS NULL OR terminal_frame_sequence BETWEEN 1 AND 100000),
        terminal_sha256 TEXT CHECK(terminal_sha256 IS NULL OR terminal_sha256 ~ '^[0-9a-f]{64}$'),
        accounting_disposition TEXT CHECK(accounting_disposition IS NULL OR accounting_disposition IN ('delegated', 'settled', 'unknown')),
        admitted_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(admitted_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(admitted_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = admitted_at
        ),
        updated_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(updated_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = updated_at
        ),
        PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, inference_request_id, attempt),
        UNIQUE(registry_workspace_id, idempotency_key),
        FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation)
          REFERENCES remote_worker_assignment_generations(registry_workspace_id, assignment_id, assignment_generation) ON DELETE RESTRICT,
        CHECK(request_body_json::jsonb ->> 'schemaVersion' = 'goatcitadel.remote-worker-inference-request.v1'),
        CHECK((governance_decision = 'approval_required') = (approval_receipt_sha256 IS NOT NULL)),
        CHECK(governance_decision <> 'denied' OR state = 'blocked'),
        CHECK((dispatch_claim_owner IS NULL) = (state IN ('admitted', 'waiting_approval', 'blocked'))),
        CHECK((dispatch_claim_owner IS NULL) = (dispatch_claimed_at IS NULL)),
        CHECK((dispatch_claim_owner IS NULL) = (dispatch_lease_expires_at IS NULL)),
        CHECK((state IN ('completed', 'failed', 'cancelled')) = (terminal_frame_sequence IS NOT NULL AND terminal_sha256 IS NOT NULL)),
        CHECK(worker_acknowledged_through <= output_frame_count)
      );

      CREATE TABLE IF NOT EXISTS remote_worker_inference_outbox (
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        assignment_id TEXT NOT NULL CHECK(length(assignment_id) BETWEEN 1 AND 256),
        assignment_generation BIGINT NOT NULL CHECK(assignment_generation > 0),
        inference_request_id TEXT NOT NULL CHECK(length(inference_request_id) BETWEEN 1 AND 256),
        attempt BIGINT NOT NULL CHECK(attempt > 0),
        frame_sequence BIGINT NOT NULL CHECK(frame_sequence BETWEEN 1 AND 100000),
        frame_kind TEXT NOT NULL CHECK(frame_kind IN ('output_text', 'terminal')),
        payload_json TEXT NOT NULL CHECK(
          jsonb_typeof(payload_json::jsonb) = 'object' AND octet_length(payload_json) <= 262144
        ),
        payload_sha256 TEXT NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
        previous_frame_sha256 TEXT NOT NULL CHECK(previous_frame_sha256 ~ '^[0-9a-f]{64}$'),
        frame_sha256 TEXT NOT NULL CHECK(frame_sha256 ~ '^[0-9a-f]{64}$'),
        effective_route_sha256 TEXT NOT NULL CHECK(effective_route_sha256 ~ '^[0-9a-f]{64}$'),
        usage_event_id TEXT CHECK(usage_event_id IS NULL OR length(usage_event_id) BETWEEN 1 AND 256),
        frame_char_count BIGINT NOT NULL CHECK(frame_char_count BETWEEN 0 AND 131072),
        created_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(created_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = created_at
        ),
        PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, inference_request_id, attempt, frame_sequence),
        UNIQUE(registry_workspace_id, frame_sha256),
        FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation, inference_request_id, attempt)
          REFERENCES remote_worker_inference_requests(
            registry_workspace_id, assignment_id, assignment_generation, inference_request_id, attempt
          ) ON DELETE RESTRICT,
        CHECK(payload_json::jsonb ->> 'schemaVersion' = 'goatcitadel.remote-worker-inference-frame.v1'),
        CHECK(payload_json::jsonb ->> 'kind' = frame_kind),
        CHECK(frame_kind = 'terminal' OR usage_event_id IS NULL)
      );

      CREATE INDEX IF NOT EXISTS idx_remote_worker_inference_requests_dispatch_lease
        ON remote_worker_inference_requests(state, dispatch_lease_expires_at)
        WHERE state IN ('dispatch_claimed', 'streaming');
      CREATE INDEX IF NOT EXISTS idx_remote_worker_inference_outbox_delivery
        ON remote_worker_inference_outbox(
          registry_workspace_id, assignment_id, assignment_generation, inference_request_id, attempt, frame_sequence
        );

      CREATE OR REPLACE FUNCTION gc_remote_worker_inference_request_immutable_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.registry_workspace_id IS DISTINCT FROM OLD.registry_workspace_id
          OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
          OR NEW.assignment_generation IS DISTINCT FROM OLD.assignment_generation
          OR NEW.inference_request_id IS DISTINCT FROM OLD.inference_request_id
          OR NEW.attempt IS DISTINCT FROM OLD.attempt
          OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
          OR NEW.worker_generation IS DISTINCT FROM OLD.worker_generation
          OR NEW.session_id IS DISTINCT FROM OLD.session_id
          OR NEW.turn_id IS DISTINCT FROM OLD.turn_id
          OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
          OR NEW.request_body_json IS DISTINCT FROM OLD.request_body_json
          OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
          OR NEW.input_sha256 IS DISTINCT FROM OLD.input_sha256
          OR NEW.context_sha256 IS DISTINCT FROM OLD.context_sha256
          OR NEW.model_intent_sha256 IS DISTINCT FROM OLD.model_intent_sha256
          OR NEW.capability_profile_sha256 IS DISTINCT FROM OLD.capability_profile_sha256
          OR NEW.routed_context_sha256 IS DISTINCT FROM OLD.routed_context_sha256
          OR NEW.output_token_ceiling IS DISTINCT FROM OLD.output_token_ceiling
          OR NEW.reasoning_token_ceiling IS DISTINCT FROM OLD.reasoning_token_ceiling
          OR NEW.temperature_milli IS DISTINCT FROM OLD.temperature_milli
          OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
          OR NEW.dispatch_generation IS DISTINCT FROM OLD.dispatch_generation
          OR NEW.policy_revision IS DISTINCT FROM OLD.policy_revision
          OR NEW.policy_sha256 IS DISTINCT FROM OLD.policy_sha256
          OR NEW.effective_route_sha256 IS DISTINCT FROM OLD.effective_route_sha256
          OR NEW.admitted_at IS DISTINCT FROM OLD.admitted_at
          OR (OLD.terminal_frame_sequence IS NOT NULL AND NEW.terminal_frame_sequence IS DISTINCT FROM OLD.terminal_frame_sequence)
          OR (OLD.terminal_sha256 IS NOT NULL AND NEW.terminal_sha256 IS DISTINCT FROM OLD.terminal_sha256) THEN
          RAISE EXCEPTION 'remote worker inference request immutable bindings cannot change' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_remote_worker_inference_request_terminal_guard()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.state IN ('completed', 'failed', 'cancelled', 'dispatch_unknown', 'blocked')
          AND (
            NEW.state IS DISTINCT FROM OLD.state
            OR NEW.dispatch_claim_owner IS DISTINCT FROM OLD.dispatch_claim_owner
            OR NEW.dispatch_lease_expires_at IS DISTINCT FROM OLD.dispatch_lease_expires_at
            OR NEW.effective_provider_id IS DISTINCT FROM OLD.effective_provider_id
            OR NEW.effective_model_id IS DISTINCT FROM OLD.effective_model_id
            OR NEW.usage_terminal_event_id IS DISTINCT FROM OLD.usage_terminal_event_id
            OR NEW.accounting_disposition IS DISTINCT FROM OLD.accounting_disposition
            OR NEW.output_frame_count IS DISTINCT FROM OLD.output_frame_count
            OR NEW.output_char_count IS DISTINCT FROM OLD.output_char_count
            OR NEW.worker_acknowledged_through < OLD.worker_acknowledged_through
          ) THEN
          RAISE EXCEPTION 'remote worker inference terminal state is immutable except monotonic acknowledgement' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_remote_worker_inference_request_ack_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.worker_acknowledged_through < OLD.worker_acknowledged_through THEN
          RAISE EXCEPTION 'remote worker inference acknowledgement watermark cannot regress' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_remote_worker_inference_outbox_chain_guard()
      RETURNS trigger AS $$
      DECLARE
        expected_sequence BIGINT;
        expected_previous TEXT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(
          NEW.registry_workspace_id || ':' || NEW.assignment_id || ':' || NEW.assignment_generation::text
            || ':' || NEW.inference_request_id || ':' || NEW.attempt::text,
          503
        ));
        SELECT 1 + COALESCE(MAX(f.frame_sequence), 0),
               COALESCE((
                 SELECT g.frame_sha256 FROM remote_worker_inference_outbox g
                 WHERE g.registry_workspace_id = NEW.registry_workspace_id
                   AND g.assignment_id = NEW.assignment_id
                   AND g.assignment_generation = NEW.assignment_generation
                   AND g.inference_request_id = NEW.inference_request_id
                   AND g.attempt = NEW.attempt
                 ORDER BY g.frame_sequence DESC LIMIT 1
               ), '${"0".repeat(64)}')
          INTO expected_sequence, expected_previous
          FROM remote_worker_inference_outbox f
          WHERE f.registry_workspace_id = NEW.registry_workspace_id
            AND f.assignment_id = NEW.assignment_id
            AND f.assignment_generation = NEW.assignment_generation
            AND f.inference_request_id = NEW.inference_request_id
            AND f.attempt = NEW.attempt;
        IF NEW.frame_sequence <> expected_sequence OR NEW.previous_frame_sha256 <> expected_previous THEN
          RAISE EXCEPTION 'remote worker inference outbox frame chain is out of order' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_reject_remote_worker_inference_outbox_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'remote worker inference outbox frames are append-only' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_remote_worker_inference_requests_immutable ON remote_worker_inference_requests;
      CREATE TRIGGER trg_remote_worker_inference_requests_immutable
        BEFORE UPDATE ON remote_worker_inference_requests
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_inference_request_immutable_guard();
      DROP TRIGGER IF EXISTS trg_remote_worker_inference_requests_terminal_guard ON remote_worker_inference_requests;
      CREATE TRIGGER trg_remote_worker_inference_requests_terminal_guard
        BEFORE UPDATE ON remote_worker_inference_requests
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_inference_request_terminal_guard();
      DROP TRIGGER IF EXISTS trg_remote_worker_inference_requests_ack_monotonic ON remote_worker_inference_requests;
      CREATE TRIGGER trg_remote_worker_inference_requests_ack_monotonic
        BEFORE UPDATE ON remote_worker_inference_requests
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_inference_request_ack_guard();

      DROP TRIGGER IF EXISTS trg_remote_worker_inference_outbox_chain_guard ON remote_worker_inference_outbox;
      CREATE TRIGGER trg_remote_worker_inference_outbox_chain_guard
        BEFORE INSERT ON remote_worker_inference_outbox
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_inference_outbox_chain_guard();
      DROP TRIGGER IF EXISTS trg_remote_worker_inference_outbox_no_update ON remote_worker_inference_outbox;
      CREATE TRIGGER trg_remote_worker_inference_outbox_no_update
        BEFORE UPDATE ON remote_worker_inference_outbox
        FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_inference_outbox_mutation();
      DROP TRIGGER IF EXISTS trg_remote_worker_inference_outbox_no_delete ON remote_worker_inference_outbox;
      CREATE TRIGGER trg_remote_worker_inference_outbox_no_delete
        BEFORE DELETE ON remote_worker_inference_outbox
        FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_inference_outbox_mutation();
    `,
  },
  {
    version: 120,
    name: "remote_worker_cell_execution_owner",
    // HX-505 remote-worker execution-cell owner (paired with SQLite 178).
    // Additive only: two new tables bound by a complete composite foreign key to
    // the committed assignment-generation authority, whose PRIMARY KEY already
    // satisfies the reference, so no frozen table is altered and no row is
    // written. The immutable server-owned profile, capacity reservation, three
    // state machines with monotonic revision CAS, high-water and retained-byte
    // truth, and an append-only hash-chained evidence log hold. No transcript,
    // artifact payload, raw terminal output, or credential ever has a column.
    // Production-dark: no route, listener, startup, scheduler, or accounting
    // owner.
    integritySha256: "b174348a802498aecd3fe81cd6d6cd70f8d2649a2469a6f732167747bfc467cb",
    sql: `
      CREATE TABLE IF NOT EXISTS remote_worker_cells (
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        assignment_id TEXT NOT NULL CHECK(length(assignment_id) BETWEEN 1 AND 256),
        assignment_generation BIGINT NOT NULL CHECK(assignment_generation > 0),
        cell_id TEXT NOT NULL CHECK(length(cell_id) BETWEEN 1 AND 256),
        worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
        worker_generation BIGINT NOT NULL CHECK(worker_generation > 0),
        backend TEXT NOT NULL CHECK(backend = 'container'),
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        profile_sha256 TEXT NOT NULL CHECK(profile_sha256 ~ '^[0-9a-f]{64}$'),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        logical_root_sha256 TEXT NOT NULL CHECK(logical_root_sha256 ~ '^[0-9a-f]{64}$'),
        assignment_manifest_sha256 TEXT NOT NULL CHECK(assignment_manifest_sha256 ~ '^[0-9a-f]{64}$'),
        path_jail_sha256 TEXT NOT NULL CHECK(path_jail_sha256 ~ '^[0-9a-f]{64}$'),
        capability_profile_sha256 TEXT NOT NULL CHECK(capability_profile_sha256 ~ '^[0-9a-f]{64}$'),
        context_snapshot_sha256 TEXT NOT NULL CHECK(context_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
        tool_effect_posture_sha256 TEXT NOT NULL CHECK(tool_effect_posture_sha256 ~ '^[0-9a-f]{64}$'),
        runtime_attestation_sha256 TEXT NOT NULL CHECK(runtime_attestation_sha256 ~ '^[0-9a-f]{64}$'),
        launcher_attestation_sha256 TEXT NOT NULL CHECK(launcher_attestation_sha256 ~ '^[0-9a-f]{64}$'),
        logical_disk_bytes BIGINT NOT NULL CHECK(logical_disk_bytes BETWEEN 1 AND 1099511627776),
        allocated_disk_bytes BIGINT NOT NULL CHECK(allocated_disk_bytes BETWEEN 1 AND 1099511627776),
        file_limit BIGINT NOT NULL CHECK(file_limit BETWEEN 1 AND 100000000),
        inode_limit BIGINT NOT NULL CHECK(inode_limit BETWEEN 1 AND 100000000),
        process_limit BIGINT NOT NULL CHECK(process_limit BETWEEN 1 AND 100000),
        cpu_limit_milli BIGINT NOT NULL CHECK(cpu_limit_milli BETWEEN 1 AND 1024000),
        wall_limit_ms BIGINT NOT NULL CHECK(wall_limit_ms BETWEEN 1 AND 604800000),
        memory_limit_bytes BIGINT NOT NULL CHECK(memory_limit_bytes BETWEEN 1 AND 1099511627776),
        raw_output_limit_bytes BIGINT NOT NULL CHECK(raw_output_limit_bytes BETWEEN 1 AND 1099511627776),
        diagnostic_limit_bytes BIGINT NOT NULL CHECK(diagnostic_limit_bytes BETWEEN 1 AND 1099511627776),
        artifact_ceiling_bytes BIGINT NOT NULL CHECK(artifact_ceiling_bytes BETWEEN 1 AND 1099511627776),
        backup_staging_bytes BIGINT NOT NULL CHECK(backup_staging_bytes BETWEEN 1 AND 1099511627776),
        backup_publication_bytes BIGINT NOT NULL CHECK(backup_publication_bytes BETWEEN 1 AND 1099511627776),
        egress_posture TEXT NOT NULL CHECK(egress_posture IN ('deny_all', 'allowlisted')),
        egress_policy_sha256 TEXT NOT NULL CHECK(egress_policy_sha256 ~ '^[0-9a-f]{64}$'),
        egress_dns_revision BIGINT NOT NULL CHECK(egress_dns_revision > 0),
        env_allowlist_sha256 TEXT NOT NULL CHECK(env_allowlist_sha256 ~ '^[0-9a-f]{64}$'),
        execution_state TEXT NOT NULL CHECK(execution_state IN (
          'profiled', 'provisioning', 'ready', 'starting', 'running',
          'exited', 'cancelled', 'limit_exceeded', 'failed', 'liveness_unknown'
        )),
        execution_revision BIGINT NOT NULL CHECK(execution_revision > 0),
        cleanup_state TEXT NOT NULL CHECK(cleanup_state IN (
          'not_started', 'pending', 'stopping', 'verifying_zero',
          'verified_clean', 'failed_cleanup', 'manual_reconciliation', 'quarantined'
        )),
        cleanup_revision BIGINT NOT NULL CHECK(cleanup_revision > 0),
        backup_state TEXT NOT NULL CHECK(backup_state IN (
          'disabled', 'pending', 'staged', 'verified', 'corrupt',
          'manual_reconciliation', 'restore_pending', 'restored', 'drifted'
        )),
        backup_revision BIGINT NOT NULL CHECK(backup_revision > 0),
        provisioning_owner TEXT CHECK(provisioning_owner IS NULL OR length(provisioning_owner) BETWEEN 1 AND 256),
        provisioning_lease_expires_at TEXT CHECK(provisioning_lease_expires_at IS NULL OR (
          gc_try_parse_timestamptz(provisioning_lease_expires_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(provisioning_lease_expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = provisioning_lease_expires_at
        )),
        platform_identity_sha256 TEXT CHECK(platform_identity_sha256 IS NULL OR platform_identity_sha256 ~ '^[0-9a-f]{64}$'),
        container_name TEXT CHECK(container_name IS NULL OR length(container_name) BETWEEN 1 AND 256),
        image_digest TEXT CHECK(image_digest IS NULL OR image_digest ~ '^sha256:[0-9a-f]{64}$'),
        network_name TEXT CHECK(network_name IS NULL OR length(network_name) BETWEEN 1 AND 256),
        peak_disk_bytes BIGINT NOT NULL DEFAULT 0 CHECK(peak_disk_bytes BETWEEN 0 AND 1099511627776),
        peak_memory_bytes BIGINT NOT NULL DEFAULT 0 CHECK(peak_memory_bytes BETWEEN 0 AND 1099511627776),
        peak_file_count BIGINT NOT NULL DEFAULT 0 CHECK(peak_file_count BETWEEN 0 AND 100000000),
        peak_process_count BIGINT NOT NULL DEFAULT 0 CHECK(peak_process_count BETWEEN 0 AND 100000),
        raw_output_bytes BIGINT NOT NULL DEFAULT 0 CHECK(raw_output_bytes BETWEEN 0 AND 1099511627776),
        retained_diagnostic_bytes BIGINT NOT NULL DEFAULT 0 CHECK(retained_diagnostic_bytes BETWEEN 0 AND 1099511627776),
        failed_cleanup_retained_bytes BIGINT NOT NULL DEFAULT 0 CHECK(failed_cleanup_retained_bytes BETWEEN 0 AND 1099511627776),
        quarantine_retained_bytes BIGINT NOT NULL DEFAULT 0 CHECK(quarantine_retained_bytes BETWEEN 0 AND 1099511627776),
        capacity_revision BIGINT NOT NULL DEFAULT 0 CHECK(capacity_revision BETWEEN 0 AND 100000),
        last_footprint_sha256 TEXT CHECK(last_footprint_sha256 IS NULL OR last_footprint_sha256 ~ '^[0-9a-f]{64}$'),
        exit_code BIGINT CHECK(exit_code IS NULL OR exit_code BETWEEN -1 AND 255),
        terminated_by_signal TEXT CHECK(terminated_by_signal IS NULL OR length(terminated_by_signal) BETWEEN 1 AND 32),
        diagnostic_capture_sha256 TEXT CHECK(diagnostic_capture_sha256 IS NULL OR diagnostic_capture_sha256 ~ '^[0-9a-f]{64}$'),
        created_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(created_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = created_at
        ),
        updated_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(updated_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = updated_at
        ),
        PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation),
        UNIQUE(registry_workspace_id, cell_id),
        UNIQUE(registry_workspace_id, idempotency_key),
        FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation)
          REFERENCES remote_worker_assignment_generations(registry_workspace_id, assignment_id, assignment_generation) ON DELETE RESTRICT,
        CHECK(allocated_disk_bytes >= logical_disk_bytes),
        CHECK((provisioning_owner IS NULL) = (provisioning_lease_expires_at IS NULL)),
        CHECK((platform_identity_sha256 IS NULL) = (container_name IS NULL)),
        CHECK((platform_identity_sha256 IS NULL) = (image_digest IS NULL)),
        CHECK((platform_identity_sha256 IS NULL) = (network_name IS NULL)),
        CHECK(execution_state IN ('profiled', 'provisioning') OR platform_identity_sha256 IS NOT NULL),
        CHECK((exit_code IS NULL) OR execution_state IN ('exited', 'limit_exceeded', 'failed', 'cancelled'))
      );

      CREATE TABLE IF NOT EXISTS remote_worker_cell_evidence (
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        assignment_id TEXT NOT NULL CHECK(length(assignment_id) BETWEEN 1 AND 256),
        assignment_generation BIGINT NOT NULL CHECK(assignment_generation > 0),
        cell_id TEXT NOT NULL CHECK(length(cell_id) BETWEEN 1 AND 256),
        evidence_sequence BIGINT NOT NULL CHECK(evidence_sequence BETWEEN 1 AND 100000),
        domain TEXT NOT NULL CHECK(domain IN ('execution', 'cleanup', 'backup', 'capacity')),
        payload_json TEXT NOT NULL CHECK(
          jsonb_typeof(payload_json::jsonb) = 'object' AND octet_length(payload_json) <= 8192
        ),
        payload_sha256 TEXT NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
        previous_evidence_sha256 TEXT NOT NULL CHECK(previous_evidence_sha256 ~ '^[0-9a-f]{64}$'),
        evidence_sha256 TEXT NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
        recorded_at TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(recorded_at) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(recorded_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = recorded_at
        ),
        PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, evidence_sequence),
        UNIQUE(registry_workspace_id, evidence_sha256),
        FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation)
          REFERENCES remote_worker_cells(registry_workspace_id, assignment_id, assignment_generation) ON DELETE RESTRICT,
        CHECK(payload_json::jsonb ->> 'schemaVersion' = 'goatcitadel.remote-worker-cell-evidence.v1'),
        CHECK(payload_json::jsonb ->> 'domain' = domain)
      );

      CREATE INDEX IF NOT EXISTS idx_remote_worker_cells_provisioning_lease
        ON remote_worker_cells(execution_state, provisioning_lease_expires_at)
        WHERE execution_state = 'provisioning';
      CREATE INDEX IF NOT EXISTS idx_remote_worker_cell_evidence_chain
        ON remote_worker_cell_evidence(
          registry_workspace_id, assignment_id, assignment_generation, evidence_sequence
        );

      CREATE OR REPLACE FUNCTION gc_remote_worker_cell_profile_immutable_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.registry_workspace_id IS DISTINCT FROM OLD.registry_workspace_id
          OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
          OR NEW.assignment_generation IS DISTINCT FROM OLD.assignment_generation
          OR NEW.cell_id IS DISTINCT FROM OLD.cell_id
          OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
          OR NEW.worker_generation IS DISTINCT FROM OLD.worker_generation
          OR NEW.backend IS DISTINCT FROM OLD.backend
          OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
          OR NEW.profile_sha256 IS DISTINCT FROM OLD.profile_sha256
          OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
          OR NEW.logical_root_sha256 IS DISTINCT FROM OLD.logical_root_sha256
          OR NEW.assignment_manifest_sha256 IS DISTINCT FROM OLD.assignment_manifest_sha256
          OR NEW.path_jail_sha256 IS DISTINCT FROM OLD.path_jail_sha256
          OR NEW.capability_profile_sha256 IS DISTINCT FROM OLD.capability_profile_sha256
          OR NEW.context_snapshot_sha256 IS DISTINCT FROM OLD.context_snapshot_sha256
          OR NEW.tool_effect_posture_sha256 IS DISTINCT FROM OLD.tool_effect_posture_sha256
          OR NEW.runtime_attestation_sha256 IS DISTINCT FROM OLD.runtime_attestation_sha256
          OR NEW.launcher_attestation_sha256 IS DISTINCT FROM OLD.launcher_attestation_sha256
          OR NEW.logical_disk_bytes IS DISTINCT FROM OLD.logical_disk_bytes
          OR NEW.allocated_disk_bytes IS DISTINCT FROM OLD.allocated_disk_bytes
          OR NEW.file_limit IS DISTINCT FROM OLD.file_limit
          OR NEW.inode_limit IS DISTINCT FROM OLD.inode_limit
          OR NEW.process_limit IS DISTINCT FROM OLD.process_limit
          OR NEW.cpu_limit_milli IS DISTINCT FROM OLD.cpu_limit_milli
          OR NEW.wall_limit_ms IS DISTINCT FROM OLD.wall_limit_ms
          OR NEW.memory_limit_bytes IS DISTINCT FROM OLD.memory_limit_bytes
          OR NEW.raw_output_limit_bytes IS DISTINCT FROM OLD.raw_output_limit_bytes
          OR NEW.diagnostic_limit_bytes IS DISTINCT FROM OLD.diagnostic_limit_bytes
          OR NEW.artifact_ceiling_bytes IS DISTINCT FROM OLD.artifact_ceiling_bytes
          OR NEW.backup_staging_bytes IS DISTINCT FROM OLD.backup_staging_bytes
          OR NEW.backup_publication_bytes IS DISTINCT FROM OLD.backup_publication_bytes
          OR NEW.egress_posture IS DISTINCT FROM OLD.egress_posture
          OR NEW.egress_policy_sha256 IS DISTINCT FROM OLD.egress_policy_sha256
          OR NEW.egress_dns_revision IS DISTINCT FROM OLD.egress_dns_revision
          OR NEW.env_allowlist_sha256 IS DISTINCT FROM OLD.env_allowlist_sha256
          OR NEW.created_at IS DISTINCT FROM OLD.created_at
          OR (OLD.platform_identity_sha256 IS NOT NULL AND NEW.platform_identity_sha256 IS DISTINCT FROM OLD.platform_identity_sha256)
          OR (OLD.container_name IS NOT NULL AND NEW.container_name IS DISTINCT FROM OLD.container_name)
          OR (OLD.image_digest IS NOT NULL AND NEW.image_digest IS DISTINCT FROM OLD.image_digest)
          OR (OLD.network_name IS NOT NULL AND NEW.network_name IS DISTINCT FROM OLD.network_name) THEN
          RAISE EXCEPTION 'remote worker cell immutable profile bindings cannot change' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_remote_worker_cell_revision_cas_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.execution_revision < OLD.execution_revision
          OR NEW.cleanup_revision < OLD.cleanup_revision
          OR NEW.backup_revision < OLD.backup_revision
          OR (NEW.execution_state IS DISTINCT FROM OLD.execution_state AND NEW.execution_revision <> OLD.execution_revision + 1)
          OR (NEW.execution_state = OLD.execution_state AND NEW.execution_revision <> OLD.execution_revision)
          OR (NEW.cleanup_state IS DISTINCT FROM OLD.cleanup_state AND NEW.cleanup_revision <> OLD.cleanup_revision + 1)
          OR (NEW.cleanup_state = OLD.cleanup_state AND NEW.cleanup_revision <> OLD.cleanup_revision)
          OR (NEW.backup_state IS DISTINCT FROM OLD.backup_state AND NEW.backup_revision <> OLD.backup_revision + 1)
          OR (NEW.backup_state = OLD.backup_state AND NEW.backup_revision <> OLD.backup_revision)
          OR (OLD.execution_state IN ('exited', 'cancelled', 'limit_exceeded', 'failed', 'liveness_unknown')
              AND NEW.execution_state IS DISTINCT FROM OLD.execution_state) THEN
          RAISE EXCEPTION 'remote worker cell state revision must advance monotonically by one on transition' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_remote_worker_cell_high_water_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.peak_disk_bytes < OLD.peak_disk_bytes
          OR NEW.peak_memory_bytes < OLD.peak_memory_bytes
          OR NEW.peak_file_count < OLD.peak_file_count
          OR NEW.peak_process_count < OLD.peak_process_count
          OR NEW.raw_output_bytes < OLD.raw_output_bytes
          OR NEW.retained_diagnostic_bytes < OLD.retained_diagnostic_bytes
          OR NEW.failed_cleanup_retained_bytes < OLD.failed_cleanup_retained_bytes
          OR NEW.quarantine_retained_bytes < OLD.quarantine_retained_bytes
          OR NEW.capacity_revision < OLD.capacity_revision THEN
          RAISE EXCEPTION 'remote worker cell high-water and retained-byte accounting cannot regress' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_remote_worker_cell_no_delete_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NOT (
          OLD.execution_state IN ('exited', 'cancelled', 'limit_exceeded', 'failed')
          AND OLD.cleanup_state = 'verified_clean'
        ) THEN
          RAISE EXCEPTION 'remote worker cell removal requires verified zero liveness' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_remote_worker_cell_evidence_chain_guard()
      RETURNS trigger AS $$
      DECLARE
        parent_cell_id TEXT;
        expected_sequence BIGINT;
        expected_previous TEXT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(
          NEW.registry_workspace_id || ':' || NEW.assignment_id || ':' || NEW.assignment_generation::text, 505
        ));
        SELECT c.cell_id INTO parent_cell_id
          FROM remote_worker_cells c
          WHERE c.registry_workspace_id = NEW.registry_workspace_id
            AND c.assignment_id = NEW.assignment_id
            AND c.assignment_generation = NEW.assignment_generation;
        SELECT 1 + COALESCE(MAX(f.evidence_sequence), 0),
               COALESCE((
                 SELECT g.evidence_sha256 FROM remote_worker_cell_evidence g
                 WHERE g.registry_workspace_id = NEW.registry_workspace_id
                   AND g.assignment_id = NEW.assignment_id
                   AND g.assignment_generation = NEW.assignment_generation
                 ORDER BY g.evidence_sequence DESC LIMIT 1
               ), '${"0".repeat(64)}')
          INTO expected_sequence, expected_previous
          FROM remote_worker_cell_evidence f
          WHERE f.registry_workspace_id = NEW.registry_workspace_id
            AND f.assignment_id = NEW.assignment_id
            AND f.assignment_generation = NEW.assignment_generation;
        IF NEW.cell_id IS DISTINCT FROM parent_cell_id
          OR NEW.evidence_sequence <> expected_sequence
          OR NEW.previous_evidence_sha256 <> expected_previous THEN
          RAISE EXCEPTION 'remote worker cell evidence chain is out of order or misbound' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_reject_remote_worker_cell_evidence_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'remote worker cell evidence is append-only' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_remote_worker_cells_profile_immutable ON remote_worker_cells;
      CREATE TRIGGER trg_remote_worker_cells_profile_immutable
        BEFORE UPDATE ON remote_worker_cells
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_cell_profile_immutable_guard();
      DROP TRIGGER IF EXISTS trg_remote_worker_cells_revision_cas ON remote_worker_cells;
      CREATE TRIGGER trg_remote_worker_cells_revision_cas
        BEFORE UPDATE ON remote_worker_cells
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_cell_revision_cas_guard();
      DROP TRIGGER IF EXISTS trg_remote_worker_cells_high_water_monotonic ON remote_worker_cells;
      CREATE TRIGGER trg_remote_worker_cells_high_water_monotonic
        BEFORE UPDATE ON remote_worker_cells
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_cell_high_water_guard();
      DROP TRIGGER IF EXISTS trg_remote_worker_cells_no_delete_unless_clean ON remote_worker_cells;
      CREATE TRIGGER trg_remote_worker_cells_no_delete_unless_clean
        BEFORE DELETE ON remote_worker_cells
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_cell_no_delete_guard();

      DROP TRIGGER IF EXISTS trg_remote_worker_cell_evidence_chain_guard ON remote_worker_cell_evidence;
      CREATE TRIGGER trg_remote_worker_cell_evidence_chain_guard
        BEFORE INSERT ON remote_worker_cell_evidence
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_cell_evidence_chain_guard();
      DROP TRIGGER IF EXISTS trg_remote_worker_cell_evidence_no_update ON remote_worker_cell_evidence;
      CREATE TRIGGER trg_remote_worker_cell_evidence_no_update
        BEFORE UPDATE ON remote_worker_cell_evidence
        FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_cell_evidence_mutation();
      DROP TRIGGER IF EXISTS trg_remote_worker_cell_evidence_no_delete ON remote_worker_cell_evidence;
      CREATE TRIGGER trg_remote_worker_cell_evidence_no_delete
        BEFORE DELETE ON remote_worker_cell_evidence
        FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_cell_evidence_mutation();
    `,
  },
  {
    version: 121,
    name: "remote_worker_settlement_owner",
    // HX-506 remote-worker settlement owner (paired with SQLite 179). Additive
    // only: nine new tables bound by complete composite foreign keys to a
    // full-identity unique key on the committed assignment generation (added here
    // as an additive index; the frozen 113 table is never altered). Parts, blobs,
    // manifests, entries, intents, and transitions are insert-only; upload/
    // verifier/cleanup/receipt mutations are revision-CAS fenced. No transcript,
    // artifact payload, raw terminal output, provider usage/cost, or credential
    // ever has a column. Forward-only with no content backfill: the migration
    // ABORTS if an existing completed remote assignment settlement cannot be
    // proven against a canonical HX-506 manifest. Production-dark: no route,
    // listener, startup, scheduler, or accounting owner.
    integritySha256: "ee425c869259c905fcaca8ca8574fe059be54c6304acfcea5404dc837b897333",
    sql: buildRemoteWorkerSettlementPostgresSql(),
  },
  {
    version: 122,
    name: "workspace_path_bridge_posix_flavor",
    // Native POSIX path-bridge evidence (paired with SQLite 180). Widens the
    // frozen `input_flavor`/`target_flavor` CHECK on the two tables that persist
    // a path flavor so a POSIX host can record its own evidence; previously
    // every flavor named a Windows host path, which made external-source
    // registration Windows-only. No column is added, dropped, or retyped and no
    // row is rewritten: the accepted domain only grows, so every existing row
    // stays valid under the new CHECK. The constraints are located through
    // pg_constraint rather than by assuming PostgreSQL's generated names.
    integritySha256: "881d90b8db7c78e8871189704acf1bc3e705d21518cc1560ae65793c6ff381bf",
    sql: buildWorkspacePathBridgePosixFlavorPostgresSql(),
  },
  {
    version: 123,
    name: "skill_aggregate_revision_constraint_repair",
    // Fresh PostgreSQL bootstraps run the generated v2 canonical schema before
    // the forward ledger. That generated schema already contains this table but
    // cannot reflect SQLite CHECK expressions, so v106's CREATE IF NOT EXISTS
    // does not install its five authority constraints. Recreate the same named
    // checks transactionally for both fresh installs and upgraded databases.
    // Existing invalid rows fail the migration closed instead of being repaired
    // or silently grandfathered.
    sql: `
      ALTER TABLE skill_aggregate_revisions
        DROP CONSTRAINT IF EXISTS skill_aggregate_revisions_aggregate_kind_check,
        DROP CONSTRAINT IF EXISTS skill_aggregate_revisions_aggregate_id_check,
        DROP CONSTRAINT IF EXISTS skill_aggregate_revisions_revision_check,
        DROP CONSTRAINT IF EXISTS skill_aggregate_revisions_created_at_check,
        DROP CONSTRAINT IF EXISTS skill_aggregate_revisions_updated_at_check;

      ALTER TABLE skill_aggregate_revisions
        ADD CONSTRAINT skill_aggregate_revisions_aggregate_kind_check
          CHECK(aggregate_kind IN ('runtime_skill', 'candidate_skill', 'activation_policy')),
        ADD CONSTRAINT skill_aggregate_revisions_aggregate_id_check
          CHECK(aggregate_id = BTRIM(aggregate_id) AND char_length(aggregate_id) BETWEEN 1 AND 256),
        ADD CONSTRAINT skill_aggregate_revisions_revision_check CHECK(revision > 0),
        ADD CONSTRAINT skill_aggregate_revisions_created_at_check CHECK(char_length(BTRIM(created_at)) > 0),
        ADD CONSTRAINT skill_aggregate_revisions_updated_at_check CHECK(char_length(BTRIM(updated_at)) > 0);
    `,
  },
  {
    version: 124,
    name: "chat_session_fork_manifests",
    sql: `
      CREATE TABLE IF NOT EXISTS chat_session_fork_manifests (
        fork_id TEXT PRIMARY KEY,
        source_session_id TEXT NOT NULL,
        source_turn_id TEXT NOT NULL,
        new_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        transcript_path_hash TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_session_forks_source
        ON chat_session_fork_manifests(source_session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_session_forks_workspace
        ON chat_session_fork_manifests(workspace_id, created_at DESC);
    `,
  },
  {
    version: 125,
    name: "notification_routing",
    sql: `
      CREATE TABLE IF NOT EXISTS notification_targets (
        target_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, revision BIGINT NOT NULL DEFAULT 1,
        label TEXT NOT NULL, kind TEXT NOT NULL, channel_connection_id TEXT, webhook_url_secret_ref TEXT,
        credential_secret_ref TEXT, lifecycle_state TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notification_targets_workspace ON notification_targets(workspace_id, lifecycle_state, updated_at DESC);
      CREATE TABLE IF NOT EXISTS notification_rules (
        rule_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, revision BIGINT NOT NULL DEFAULT 1,
        label TEXT NOT NULL, event_types_json TEXT NOT NULL, target_ids_json TEXT NOT NULL,
        delivery_policy TEXT NOT NULL DEFAULT 'always', lifecycle_state TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notification_rules_workspace ON notification_rules(workspace_id, lifecycle_state, updated_at DESC);
      CREATE TABLE IF NOT EXISTS notification_presence_leases (
        lease_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, client_id TEXT NOT NULL, session_id TEXT,
        focused BIGINT NOT NULL DEFAULT 0, visible BIGINT NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notification_presence_active ON notification_presence_leases(workspace_id, expires_at DESC);
      CREATE TABLE IF NOT EXISTS notification_events (
        event_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, event_type TEXT NOT NULL, session_id TEXT, turn_id TEXT,
        title TEXT NOT NULL, message TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notification_events_workspace ON notification_events(workspace_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        delivery_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, rule_id TEXT NOT NULL, target_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
        attempt_count BIGINT NOT NULL DEFAULT 0, last_error TEXT, external_side_effect_run_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notification_deliveries_workspace ON notification_deliveries(workspace_id, created_at DESC);
    `,
  },
  {
    version: 126,
    name: "chat_timers",
    sql: `
      CREATE TABLE IF NOT EXISTS chat_timers (
        timer_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES chat_session_meta(session_id) ON DELETE CASCADE,
        revision BIGINT NOT NULL DEFAULT 1,
        due_at TEXT NOT NULL,
        timezone TEXT NOT NULL,
        message TEXT NOT NULL,
        notification_rule_id TEXT,
        cancel_on_next_reply BIGINT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_by TEXT,
        claim_expires_at TEXT,
        notice_message_id TEXT,
        notification_event_id TEXT,
        notification_delivery_status TEXT,
        fired_at TEXT,
        cancelled_at TEXT,
        cancelled_by_message_id TEXT,
        failure TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_chat_timers_due
        ON chat_timers(status, due_at, claim_expires_at);
      CREATE INDEX IF NOT EXISTS idx_chat_timers_session
        ON chat_timers(session_id, status, due_at);
      CREATE INDEX IF NOT EXISTS idx_chat_timers_workspace
        ON chat_timers(workspace_id, status, due_at);
    `,
  },
  {
    version: 127,
    name: "typed_run_variables",
    sql: `
      ALTER TABLE prompt_packs ADD COLUMN IF NOT EXISTS run_variable_schema_json TEXT;
      ALTER TABLE prompt_packs ADD COLUMN IF NOT EXISTS run_variable_schema_hash TEXT;
      ALTER TABLE prompt_pack_runs ADD COLUMN IF NOT EXISTS run_variables_json TEXT;
      CREATE TABLE IF NOT EXISTS chat_session_run_variable_bindings (
        session_id TEXT NOT NULL REFERENCES chat_session_meta(session_id) ON DELETE CASCADE,
        owner_kind TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        owner_revision TEXT NOT NULL,
        schema_hash TEXT NOT NULL,
        bindings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, owner_kind, owner_id)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_session_run_variables_session
        ON chat_session_run_variable_bindings(session_id, updated_at DESC);
    `,
  },
  {
    version: 128,
    name: "document_editing",
    sql: `
      DO $routed_context_v2$
      DECLARE constraint_name TEXT;
      BEGIN
        IF to_regclass('public.chat_routed_context_snapshots') IS NOT NULL THEN
          FOR constraint_name IN
            SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.chat_routed_context_snapshots'::regclass
              AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%schema_version%'
          LOOP
            EXECUTE format('ALTER TABLE public.chat_routed_context_snapshots DROP CONSTRAINT %I', constraint_name);
          END LOOP;
          ALTER TABLE public.chat_routed_context_snapshots
            ADD CONSTRAINT chat_routed_context_snapshots_schema_version_v2_check
            CHECK(schema_version IN ('chat.routed-context-snapshot.v1', 'chat.routed-context-snapshot.v2'));
        END IF;
      END
      $routed_context_v2$;
      CREATE TABLE IF NOT EXISTS personal_ops_notes (
        note_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        lifecycle_status TEXT NOT NULL,
        revision BIGINT NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_personal_ops_notes_workspace_updated
        ON personal_ops_notes(workspace_id, updated_at);
      ALTER TABLE personal_ops_notes ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;
      CREATE TABLE IF NOT EXISTS personal_ops_note_revisions (
        note_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        revision BIGINT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        source TEXT NOT NULL,
        proposal_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (note_id, revision)
      );
      INSERT INTO personal_ops_note_revisions (
        note_id, workspace_id, revision, title, body, tags_json, source_refs_json,
        content_hash, actor_id, source, created_at
      )
      SELECT note_id, workspace_id, 1, title, body, tags_json, source_refs_json,
             'legacy-import:' || note_id, 'migration', 'migration', updated_at
      FROM personal_ops_notes
      ON CONFLICT (note_id, revision) DO NOTHING;
      CREATE INDEX IF NOT EXISTS idx_personal_ops_note_revisions_workspace
        ON personal_ops_note_revisions(workspace_id, note_id, revision DESC);

      CREATE TABLE IF NOT EXISTS document_patch_proposals (
        proposal_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id TEXT,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        base_revision BIGINT,
        base_content_hash TEXT,
        proposed_content TEXT NOT NULL,
        derived_diff TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        author_id TEXT NOT NULL,
        turn_id TEXT,
        state TEXT NOT NULL,
        applied_target_id TEXT,
        applied_revision BIGINT,
        applied_content_hash TEXT,
        conflict_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_document_patch_proposals_scope
        ON document_patch_proposals(workspace_id, session_id, state, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_document_patch_proposals_target
        ON document_patch_proposals(workspace_id, target_kind, target_id, created_at DESC);
    `,
  },
  {
    version: 129,
    name: "compound_engineering_foundation",
    sql: `
      ALTER TABLE prompt_pack_benchmark_runs ADD COLUMN IF NOT EXISTS pack_content_sha256 TEXT;
      ALTER TABLE prompt_pack_benchmark_runs ADD COLUMN IF NOT EXISTS policy_hash TEXT;
      ALTER TABLE prompt_pack_benchmark_runs ADD COLUMN IF NOT EXISTS test_snapshot_json TEXT;
      ALTER TABLE prompt_pack_benchmark_runs ADD COLUMN IF NOT EXISTS test_snapshot_sha256 TEXT;
      ALTER TABLE prompt_pack_benchmark_runs ADD COLUMN IF NOT EXISTS scoring_snapshot_json TEXT;
      ALTER TABLE replay_regression_runs ADD COLUMN IF NOT EXISTS baseline_benchmark_run_id TEXT;
      ALTER TABLE chat_delegation_steps ADD COLUMN IF NOT EXISTS work_result_json TEXT;
      ALTER TABLE chat_delegation_steps ADD COLUMN IF NOT EXISTS scope_control_json TEXT;

      CREATE TABLE IF NOT EXISTS prompt_retune_campaigns (
        campaign_id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        status TEXT NOT NULL,
        baseline_content_sha256 TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        scoring_snapshot_json TEXT NOT NULL,
        test_codes_json TEXT NOT NULL,
        providers_json TEXT NOT NULL,
        execution_style TEXT NOT NULL,
        repeat_count BIGINT NOT NULL,
        max_benchmark_runs BIGINT NOT NULL,
        success_bar_json TEXT NOT NULL,
        noise_floor_json TEXT,
        baseline_metrics_json TEXT,
        active_pass_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_retune_campaigns_pack_updated
        ON prompt_retune_campaigns(pack_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prompt_retune_campaigns_status
        ON prompt_retune_campaigns(status, updated_at ASC);

      CREATE TABLE IF NOT EXISTS prompt_retune_passes (
        pass_id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES prompt_retune_campaigns(campaign_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        hypothesis TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        benchmark_run_ids_json TEXT NOT NULL,
        disposition TEXT NOT NULL,
        metrics_json TEXT,
        eligibility TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_retune_passes_campaign_created
        ON prompt_retune_passes(campaign_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS structured_review_runs (
        review_run_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        root_path TEXT NOT NULL,
        reviewed_sha TEXT NOT NULL,
        diff_hash TEXT NOT NULL,
        changed_files_json TEXT NOT NULL,
        reviewer_roster_json TEXT NOT NULL,
        preflight_json TEXT NOT NULL DEFAULT '{}',
        model_receipts_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_structured_review_runs_created
        ON structured_review_runs(created_at DESC);

      CREATE TABLE IF NOT EXISTS structured_review_findings (
        finding_id TEXT PRIMARY KEY,
        review_run_id TEXT NOT NULL REFERENCES structured_review_runs(review_run_id) ON DELETE CASCADE,
        record_json TEXT NOT NULL,
        status TEXT NOT NULL,
        linked_task_id TEXT,
        fix_approval_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_structured_review_findings_run
        ON structured_review_findings(review_run_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_structured_review_findings_status
        ON structured_review_findings(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS engineering_learnings (
        learning_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        project_id TEXT,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        record_json TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        supersedes_learning_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_engineering_learnings_run_once
        ON engineering_learnings(workspace_id, source_run_id);
      CREATE INDEX IF NOT EXISTS idx_engineering_learnings_scope_status
        ON engineering_learnings(workspace_id, project_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_engineering_learnings_fingerprint
        ON engineering_learnings(workspace_id, fingerprint);
    `,
  },
  {
    version: 130,
    name: "session_control_lifecycle_bootstrap_clock_guard",
    sql: `
      DO $session_control_lifecycle_bootstrap_clock_guard$
      DECLARE function_sql TEXT;
      DECLARE upgraded_sql TEXT;
      DECLARE anchor TEXT := 'AND NOT auth_bypass';
      DECLARE replacement TEXT := $lifecycle_bootstrap_clock_evidence$AND NOT auth_bypass
            AND NOT EXISTS (
              SELECT 1
              FROM chat_session_lifecycle_intents intent
              JOIN chat_session_meta meta
                ON meta.lifecycle_intent_id = intent.intent_id
              WHERE /* lifecycle bootstrap clock evidence */
                intent.workspace_id = NEW.workspace_id
                AND intent.session_id = NEW.session_id
                AND intent.intent_kind IN ('initialize', 'reactivate')
                AND intent.session_incarnation_id = intent.intent_id
                AND intent.next_generation = NEW.generation
                AND intent.idempotency_key = NEW.transition_idempotency_key
                AND intent.request_sha256 = NEW.transition_request_sha256
                AND intent.created_at = NEW.created_at
                AND NEW.updated_at = intent.created_at
                AND NEW.is_current = 1
                AND NEW.owner_kind = 'operator'
                AND NEW.lease_state = 'operator_active'
                AND meta.workspace_id = NEW.workspace_id
                AND meta.session_id = NEW.session_id
                AND meta.lifecycle_intent_id = intent.intent_id
                AND meta.deletion_intent_id IS NULL
                AND meta.lifecycle_status = 'active'
            )$lifecycle_bootstrap_clock_evidence$;
      BEGIN
        SELECT pg_get_functiondef(to_regprocedure('gc_session_control_grant_insert_guard()'))
          INTO function_sql;
        IF function_sql IS NULL THEN
          RAISE EXCEPTION 'Postgres migration 130 requires the session-control grant insert guard'
            USING ERRCODE = '23514';
        END IF;
        IF strpos(function_sql, 'lifecycle bootstrap clock evidence') = 0 THEN
          IF strpos(function_sql, anchor) = 0 THEN
            RAISE EXCEPTION 'Postgres migration 130 could not locate the grant clock guard anchor'
              USING ERRCODE = '23514';
          END IF;
          upgraded_sql := replace(function_sql, anchor, replacement);
          IF upgraded_sql = function_sql THEN
            RAISE EXCEPTION 'Postgres migration 130 did not upgrade the grant clock guard'
              USING ERRCODE = '23514';
          END IF;
          EXECUTE upgraded_sql;
        END IF;
        SELECT pg_get_functiondef(to_regprocedure('gc_session_control_grant_insert_guard()'))
          INTO function_sql;
        IF strpos(function_sql, 'lifecycle bootstrap clock evidence') = 0 THEN
          RAISE EXCEPTION 'Postgres migration 130 grant clock guard assertion failed'
            USING ERRCODE = '23514';
        END IF;
      END;
      $session_control_lifecycle_bootstrap_clock_guard$;
    `,
  },
  {
    version: 131,
    name: "durable_chat_secure_configuration_reservations",
    sql: `
      CREATE TABLE IF NOT EXISTS chat_turn_secure_configuration_reservations (
        reservation_id TEXT PRIMARY KEY CHECK(length(btrim(reservation_id)) BETWEEN 1 AND 256),
        version BIGINT NOT NULL CHECK(version = 1),
        admission_id TEXT NOT NULL CHECK(length(btrim(admission_id)) BETWEEN 1 AND 256),
        session_incarnation_id TEXT NOT NULL CHECK(length(btrim(session_incarnation_id)) BETWEEN 1 AND 320),
        workspace_id TEXT NOT NULL CHECK(length(btrim(workspace_id)) BETWEEN 1 AND 80),
        session_id TEXT NOT NULL CHECK(length(btrim(session_id)) BETWEEN 1 AND 256),
        turn_id TEXT NOT NULL CHECK(length(btrim(turn_id)) BETWEEN 1 AND 256),
        durable_run_id TEXT NOT NULL CHECK(length(btrim(durable_run_id)) BETWEEN 1 AND 256),
        prompt_id TEXT NOT NULL CHECK(length(btrim(prompt_id)) BETWEEN 1 AND 256),
        target_id TEXT NOT NULL CHECK(length(btrim(target_id)) BETWEEN 1 AND 256),
        responder_actor_id TEXT NOT NULL CHECK(length(btrim(responder_actor_id)) BETWEEN 1 AND 256),
        responder_auth_actor_source TEXT NOT NULL
          CHECK(responder_auth_actor_source IN ('none', 'token', 'basic', 'loopback')),
        waiting_run_version BIGINT NOT NULL CHECK(waiting_run_version > 0),
        reserved_run_version BIGINT NOT NULL CHECK(reserved_run_version = waiting_run_version + 1),
        expires_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(expires_at) IS NOT NULL),
        status TEXT NOT NULL CHECK(status IN (
          'reserved', 'completed', 'released', 'expired_unreconciled', 'reconciled'
        )),
        provider TEXT,
        configuration_revision TEXT,
        scope_ref TEXT NOT NULL CHECK(length(btrim(scope_ref)) BETWEEN 1 AND 256),
        reserved_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(reserved_at) IS NOT NULL),
        reclaimed_at TEXT,
        completed_at TEXT,
        released_at TEXT,
        expired_at TEXT,
        reconciled_at TEXT,
        reconciled_by_reservation_id TEXT,
        UNIQUE(admission_id, durable_run_id, prompt_id, waiting_run_version),
        FOREIGN KEY(admission_id) REFERENCES chat_session_mutation_admissions(admission_id) ON DELETE RESTRICT,
        FOREIGN KEY(durable_run_id) REFERENCES durable_runs(run_id) ON DELETE RESTRICT,
        FOREIGN KEY(reconciled_by_reservation_id)
          REFERENCES chat_turn_secure_configuration_reservations(reservation_id) ON DELETE RESTRICT,
        CHECK(
          (status = 'reserved' AND provider IS NULL AND configuration_revision IS NULL
            AND completed_at IS NULL AND released_at IS NULL AND expired_at IS NULL
            AND (reclaimed_at IS NULL OR gc_try_parse_timestamptz(reclaimed_at) IS NOT NULL)
            AND reconciled_at IS NULL AND reconciled_by_reservation_id IS NULL)
          OR (status = 'completed' AND length(btrim(provider)) BETWEEN 1 AND 128
            AND configuration_revision ~ '^[0-9a-f]{64}$'
            AND gc_try_parse_timestamptz(completed_at) IS NOT NULL
            AND released_at IS NULL AND expired_at IS NULL
            AND (reclaimed_at IS NULL OR gc_try_parse_timestamptz(reclaimed_at) IS NOT NULL)
            AND reconciled_at IS NULL AND reconciled_by_reservation_id IS NULL)
          OR (status = 'released' AND provider IS NULL AND configuration_revision IS NULL
            AND completed_at IS NULL AND gc_try_parse_timestamptz(released_at) IS NOT NULL
            AND expired_at IS NULL AND reclaimed_at IS NULL AND reconciled_at IS NULL
            AND reconciled_by_reservation_id IS NULL)
          OR (status = 'expired_unreconciled' AND provider IS NULL AND configuration_revision IS NULL
            AND completed_at IS NULL AND released_at IS NULL
            AND gc_try_parse_timestamptz(expired_at) IS NOT NULL
            AND (reclaimed_at IS NULL OR gc_try_parse_timestamptz(reclaimed_at) IS NOT NULL)
            AND reconciled_at IS NULL AND reconciled_by_reservation_id IS NULL)
          OR (status = 'reconciled' AND provider IS NULL AND configuration_revision IS NULL
            AND completed_at IS NULL AND released_at IS NULL
            AND gc_try_parse_timestamptz(expired_at) IS NOT NULL
            AND (reclaimed_at IS NULL OR gc_try_parse_timestamptz(reclaimed_at) IS NOT NULL)
            AND gc_try_parse_timestamptz(reconciled_at) IS NOT NULL
            AND length(btrim(reconciled_by_reservation_id)) BETWEEN 1 AND 256)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_turn_secure_configuration_one_reserved
        ON chat_turn_secure_configuration_reservations(admission_id, durable_run_id, prompt_id)
        WHERE status = 'reserved';
      CREATE INDEX IF NOT EXISTS idx_chat_turn_secure_configuration_run_status
        ON chat_turn_secure_configuration_reservations(durable_run_id, status, reserved_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_turn_secure_configuration_one_target_scope
        ON chat_turn_secure_configuration_reservations(target_id, scope_ref)
        WHERE status = 'reserved';

      CREATE OR REPLACE FUNCTION gc_secure_configuration_reservation_update_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NOT (
            (OLD.status = 'reserved' AND NEW.status IN ('completed', 'released', 'expired_unreconciled'))
            OR (OLD.status = 'reserved' AND NEW.status = 'reserved'
              AND OLD.reclaimed_at IS NULL AND gc_try_parse_timestamptz(NEW.reclaimed_at) IS NOT NULL)
            OR (OLD.status = 'expired_unreconciled' AND NEW.status = 'reconciled')
          )
          OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
          OR NEW.version IS DISTINCT FROM OLD.version
          OR NEW.admission_id IS DISTINCT FROM OLD.admission_id
          OR NEW.session_incarnation_id IS DISTINCT FROM OLD.session_incarnation_id
          OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
          OR NEW.session_id IS DISTINCT FROM OLD.session_id
          OR NEW.turn_id IS DISTINCT FROM OLD.turn_id
          OR NEW.durable_run_id IS DISTINCT FROM OLD.durable_run_id
          OR NEW.prompt_id IS DISTINCT FROM OLD.prompt_id
          OR NEW.target_id IS DISTINCT FROM OLD.target_id
          OR NEW.responder_actor_id IS DISTINCT FROM OLD.responder_actor_id
          OR NEW.responder_auth_actor_source IS DISTINCT FROM OLD.responder_auth_actor_source
          OR NEW.waiting_run_version IS DISTINCT FROM OLD.waiting_run_version
          OR NEW.reserved_run_version IS DISTINCT FROM OLD.reserved_run_version
          OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
          OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at
          OR NEW.scope_ref IS DISTINCT FROM OLD.scope_ref
          OR (OLD.reclaimed_at IS NOT NULL AND NEW.reclaimed_at IS DISTINCT FROM OLD.reclaimed_at) THEN
          RAISE EXCEPTION 'secure configuration reservation transition invariant violated'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_chat_turn_secure_configuration_reservations_update_guard
        ON chat_turn_secure_configuration_reservations;
      CREATE TRIGGER trg_chat_turn_secure_configuration_reservations_update_guard
        BEFORE UPDATE ON chat_turn_secure_configuration_reservations
        FOR EACH ROW EXECUTE FUNCTION gc_secure_configuration_reservation_update_guard();

      CREATE OR REPLACE FUNCTION gc_reject_secure_configuration_reservation_delete()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'secure configuration reservations are append-only' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_chat_turn_secure_configuration_reservations_no_delete
        ON chat_turn_secure_configuration_reservations;
      CREATE TRIGGER trg_chat_turn_secure_configuration_reservations_no_delete
        BEFORE DELETE ON chat_turn_secure_configuration_reservations
        FOR EACH ROW EXECUTE FUNCTION gc_reject_secure_configuration_reservation_delete();

      CREATE OR REPLACE FUNCTION gc_secure_configuration_admission_close_guard()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.status = 'active' AND NEW.status <> 'active' AND EXISTS (
          SELECT 1 FROM chat_turn_secure_configuration_reservations reservation
          WHERE reservation.admission_id = OLD.admission_id AND reservation.status = 'reserved'
            AND gc_try_parse_timestamptz(reservation.expires_at) > clock_timestamp()
        ) THEN
          RAISE EXCEPTION 'active secure configuration reservation blocks admission close'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_chat_session_mutation_admissions_secure_reservation_close_guard
        ON chat_session_mutation_admissions;
      CREATE TRIGGER trg_chat_session_mutation_admissions_secure_reservation_close_guard
        BEFORE UPDATE OF status ON chat_session_mutation_admissions
        FOR EACH ROW EXECUTE FUNCTION gc_secure_configuration_admission_close_guard();

      CREATE OR REPLACE FUNCTION gc_secure_configuration_durable_run_transition_guard()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.status = 'waiting' AND NEW.status <> 'waiting' AND EXISTS (
          SELECT 1 FROM chat_turn_secure_configuration_reservations reservation
          WHERE reservation.durable_run_id = OLD.run_id AND reservation.status = 'reserved'
            AND gc_try_parse_timestamptz(reservation.expires_at) > clock_timestamp()
        ) THEN
          RAISE EXCEPTION 'active secure configuration reservation blocks durable run transition'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_durable_runs_secure_reservation_cancel_guard ON durable_runs;
      CREATE TRIGGER trg_durable_runs_secure_reservation_cancel_guard
        BEFORE UPDATE OF status ON durable_runs
        FOR EACH ROW EXECUTE FUNCTION gc_secure_configuration_durable_run_transition_guard();
    `,
  },
  {
    version: 132,
    name: "repair_durable_chat_secure_configuration_reservations",
    sql: `
      DO $secure_configuration_shape_preflight$
      DECLARE
        actual_columns TEXT[];
        final_columns CONSTANT TEXT[] := ARRAY[
          'admission_id', 'completed_at', 'configuration_revision', 'durable_run_id',
          'expired_at', 'expires_at', 'prompt_id', 'provider', 'reclaimed_at',
          'reconciled_at', 'reconciled_by_reservation_id', 'released_at', 'reservation_id',
          'reserved_at', 'reserved_run_version', 'responder_actor_id',
          'responder_auth_actor_source', 'scope_ref', 'session_id', 'session_incarnation_id',
          'status', 'target_id', 'turn_id', 'version', 'waiting_run_version', 'workspace_id'
        ];
        prototype_columns CONSTANT TEXT[] := ARRAY[
          'admission_id', 'completed_at', 'configuration_revision', 'durable_run_id',
          'expires_at', 'prompt_id', 'provider', 'released_at', 'reservation_id',
          'reserved_at', 'reserved_run_version', 'responder_actor_id',
          'responder_auth_actor_source', 'scope_ref', 'session_id', 'session_incarnation_id',
          'status', 'target_id', 'turn_id', 'version', 'waiting_run_version', 'workspace_id'
        ];
      BEGIN
        IF to_regclass('chat_turn_secure_configuration_reservations') IS NULL THEN
          RAISE EXCEPTION
            'Postgres migration 132 requires the migration 131 secure configuration reservation table'
            USING ERRCODE = '23514';
        END IF;

        SELECT array_agg(attribute.attname ORDER BY attribute.attname)
          INTO actual_columns
        FROM pg_attribute attribute
        WHERE attribute.attrelid = 'chat_turn_secure_configuration_reservations'::regclass
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped;

        IF actual_columns IS DISTINCT FROM final_columns
          AND actual_columns IS DISTINCT FROM prototype_columns THEN
          RAISE EXCEPTION
            'Postgres migration 132 found an unsupported secure configuration reservation table shape: %',
            actual_columns
            USING ERRCODE = '23514';
        END IF;

        IF EXISTS (
          SELECT 1 FROM chat_turn_secure_configuration_reservations
          WHERE scope_ref IS NULL OR length(btrim(scope_ref)) NOT BETWEEN 1 AND 256
        ) THEN
          RAISE EXCEPTION
            'Postgres migration 132 cannot infer installation scope from a missing or invalid secure configuration scope_ref'
            USING ERRCODE = '23514';
        END IF;
      END;
      $secure_configuration_shape_preflight$;

      DROP TRIGGER IF EXISTS trg_chat_turn_secure_configuration_reservations_update_guard
        ON chat_turn_secure_configuration_reservations;
      DROP TRIGGER IF EXISTS trg_chat_session_mutation_admissions_secure_reservation_close_guard
        ON chat_session_mutation_admissions;
      DROP TRIGGER IF EXISTS trg_durable_runs_secure_reservation_cancel_guard ON durable_runs;

      ALTER TABLE chat_turn_secure_configuration_reservations
        ADD COLUMN IF NOT EXISTS reclaimed_at TEXT,
        ADD COLUMN IF NOT EXISTS expired_at TEXT,
        ADD COLUMN IF NOT EXISTS reconciled_at TEXT,
        ADD COLUMN IF NOT EXISTS reconciled_by_reservation_id TEXT;

      DO $secure_configuration_drop_deployed_status_checks$
      DECLARE
        constraint_name TEXT;
      BEGIN
        FOR constraint_name IN
          SELECT constraint_row.conname
          FROM pg_constraint constraint_row
          WHERE constraint_row.conrelid = 'chat_turn_secure_configuration_reservations'::regclass
            AND constraint_row.contype = 'c'
            AND pg_get_constraintdef(constraint_row.oid) ~* '\\mstatus\\M'
        LOOP
          EXECUTE format(
            'ALTER TABLE chat_turn_secure_configuration_reservations DROP CONSTRAINT %I',
            constraint_name
          );
        END LOOP;
      END;
      $secure_configuration_drop_deployed_status_checks$;

      UPDATE chat_turn_secure_configuration_reservations
      SET status = 'expired_unreconciled',
          expired_at = COALESCE(
            expired_at,
            to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )
      WHERE status = 'reserved';

      ALTER TABLE chat_turn_secure_configuration_reservations
        ALTER COLUMN scope_ref SET NOT NULL;
      ALTER TABLE chat_turn_secure_configuration_reservations
        DROP CONSTRAINT IF EXISTS chat_turn_secure_configuration_reservations_scope_ref_check;
      ALTER TABLE chat_turn_secure_configuration_reservations
        ADD CONSTRAINT chat_turn_secure_configuration_reservations_scope_ref_check
          CHECK(length(btrim(scope_ref)) BETWEEN 1 AND 256);

      ALTER TABLE chat_turn_secure_configuration_reservations
        ADD CONSTRAINT chat_turn_secure_configuration_reservations_status_check
          CHECK(status IN ('reserved', 'completed', 'released', 'expired_unreconciled', 'reconciled')),
        ADD CONSTRAINT chat_turn_secure_configuration_reservations_lifecycle_check
          CHECK(
            (status = 'reserved' AND provider IS NULL AND configuration_revision IS NULL
              AND completed_at IS NULL AND released_at IS NULL AND expired_at IS NULL
              AND (reclaimed_at IS NULL OR gc_try_parse_timestamptz(reclaimed_at) IS NOT NULL)
              AND reconciled_at IS NULL AND reconciled_by_reservation_id IS NULL)
            OR (status = 'completed' AND length(btrim(provider)) BETWEEN 1 AND 128
              AND configuration_revision ~ '^[0-9a-f]{64}$'
              AND gc_try_parse_timestamptz(completed_at) IS NOT NULL
              AND released_at IS NULL AND expired_at IS NULL
              AND (reclaimed_at IS NULL OR gc_try_parse_timestamptz(reclaimed_at) IS NOT NULL)
              AND reconciled_at IS NULL AND reconciled_by_reservation_id IS NULL)
            OR (status = 'released' AND provider IS NULL AND configuration_revision IS NULL
              AND completed_at IS NULL AND gc_try_parse_timestamptz(released_at) IS NOT NULL
              AND expired_at IS NULL AND reclaimed_at IS NULL AND reconciled_at IS NULL
              AND reconciled_by_reservation_id IS NULL)
            OR (status = 'expired_unreconciled' AND provider IS NULL AND configuration_revision IS NULL
              AND completed_at IS NULL AND released_at IS NULL
              AND gc_try_parse_timestamptz(expired_at) IS NOT NULL
              AND (reclaimed_at IS NULL OR gc_try_parse_timestamptz(reclaimed_at) IS NOT NULL)
              AND reconciled_at IS NULL AND reconciled_by_reservation_id IS NULL)
            OR (status = 'reconciled' AND provider IS NULL AND configuration_revision IS NULL
              AND completed_at IS NULL AND released_at IS NULL
              AND gc_try_parse_timestamptz(expired_at) IS NOT NULL
              AND (reclaimed_at IS NULL OR gc_try_parse_timestamptz(reclaimed_at) IS NOT NULL)
              AND gc_try_parse_timestamptz(reconciled_at) IS NOT NULL
              AND length(btrim(reconciled_by_reservation_id)) BETWEEN 1 AND 256)
          );

      DO $secure_configuration_reconciliation_foreign_key$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_row
          WHERE constraint_row.conrelid = 'chat_turn_secure_configuration_reservations'::regclass
            AND constraint_row.contype = 'f'
            AND pg_get_constraintdef(constraint_row.oid) ~
              'FOREIGN KEY \\(reconciled_by_reservation_id\\) REFERENCES chat_turn_secure_configuration_reservations\\(reservation_id\\)'
        ) THEN
          ALTER TABLE chat_turn_secure_configuration_reservations
            ADD CONSTRAINT chat_turn_secure_configuration_reservations_reconciled_by_fkey
            FOREIGN KEY(reconciled_by_reservation_id)
              REFERENCES chat_turn_secure_configuration_reservations(reservation_id) ON DELETE RESTRICT;
        END IF;
      END;
      $secure_configuration_reconciliation_foreign_key$;

      DROP INDEX IF EXISTS idx_chat_turn_secure_configuration_one_reserved;
      DROP INDEX IF EXISTS idx_chat_turn_secure_configuration_run_status;
      DROP INDEX IF EXISTS idx_chat_turn_secure_configuration_one_target_scope;
      CREATE UNIQUE INDEX idx_chat_turn_secure_configuration_one_reserved
        ON chat_turn_secure_configuration_reservations(admission_id, durable_run_id, prompt_id)
        WHERE status = 'reserved';
      CREATE INDEX idx_chat_turn_secure_configuration_run_status
        ON chat_turn_secure_configuration_reservations(durable_run_id, status, reserved_at);
      CREATE UNIQUE INDEX idx_chat_turn_secure_configuration_one_target_scope
        ON chat_turn_secure_configuration_reservations(target_id, scope_ref)
        WHERE status = 'reserved';

      CREATE OR REPLACE FUNCTION gc_secure_configuration_reservation_update_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NOT (
            (OLD.status = 'reserved' AND NEW.status IN ('completed', 'released', 'expired_unreconciled'))
            OR (OLD.status = 'reserved' AND NEW.status = 'reserved'
              AND OLD.reclaimed_at IS NULL AND gc_try_parse_timestamptz(NEW.reclaimed_at) IS NOT NULL)
            OR (OLD.status = 'expired_unreconciled' AND NEW.status = 'expired_unreconciled'
              AND OLD.reclaimed_at IS NULL AND gc_try_parse_timestamptz(NEW.reclaimed_at) IS NOT NULL)
            OR (OLD.status = 'expired_unreconciled' AND NEW.status = 'reconciled')
          )
          OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
          OR NEW.version IS DISTINCT FROM OLD.version
          OR NEW.admission_id IS DISTINCT FROM OLD.admission_id
          OR NEW.session_incarnation_id IS DISTINCT FROM OLD.session_incarnation_id
          OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
          OR NEW.session_id IS DISTINCT FROM OLD.session_id
          OR NEW.turn_id IS DISTINCT FROM OLD.turn_id
          OR NEW.durable_run_id IS DISTINCT FROM OLD.durable_run_id
          OR NEW.prompt_id IS DISTINCT FROM OLD.prompt_id
          OR NEW.target_id IS DISTINCT FROM OLD.target_id
          OR NEW.responder_actor_id IS DISTINCT FROM OLD.responder_actor_id
          OR NEW.responder_auth_actor_source IS DISTINCT FROM OLD.responder_auth_actor_source
          OR NEW.waiting_run_version IS DISTINCT FROM OLD.waiting_run_version
          OR NEW.reserved_run_version IS DISTINCT FROM OLD.reserved_run_version
          OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
          OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at
          OR NEW.scope_ref IS DISTINCT FROM OLD.scope_ref
          OR (OLD.reclaimed_at IS NOT NULL AND NEW.reclaimed_at IS DISTINCT FROM OLD.reclaimed_at) THEN
          RAISE EXCEPTION 'secure configuration reservation transition invariant violated'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_turn_secure_configuration_reservations_update_guard
        BEFORE UPDATE ON chat_turn_secure_configuration_reservations
        FOR EACH ROW EXECUTE FUNCTION gc_secure_configuration_reservation_update_guard();

      CREATE OR REPLACE FUNCTION gc_reject_secure_configuration_reservation_delete()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'secure configuration reservations are append-only' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_chat_turn_secure_configuration_reservations_no_delete
        ON chat_turn_secure_configuration_reservations;
      CREATE TRIGGER trg_chat_turn_secure_configuration_reservations_no_delete
        BEFORE DELETE ON chat_turn_secure_configuration_reservations
        FOR EACH ROW EXECUTE FUNCTION gc_reject_secure_configuration_reservation_delete();

      CREATE OR REPLACE FUNCTION gc_secure_configuration_admission_close_guard()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.status = 'active' AND NEW.status <> 'active' AND EXISTS (
          SELECT 1 FROM chat_turn_secure_configuration_reservations reservation
          WHERE reservation.admission_id = OLD.admission_id AND reservation.status = 'reserved'
            AND gc_try_parse_timestamptz(reservation.expires_at) > clock_timestamp()
        ) THEN
          RAISE EXCEPTION 'active secure configuration reservation blocks admission close'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_chat_session_mutation_admissions_secure_reservation_close_guard
        BEFORE UPDATE OF status ON chat_session_mutation_admissions
        FOR EACH ROW EXECUTE FUNCTION gc_secure_configuration_admission_close_guard();

      CREATE OR REPLACE FUNCTION gc_secure_configuration_durable_run_transition_guard()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.status = 'waiting' AND NEW.status <> 'waiting' AND EXISTS (
          SELECT 1 FROM chat_turn_secure_configuration_reservations reservation
          WHERE reservation.durable_run_id = OLD.run_id AND reservation.status = 'reserved'
            AND gc_try_parse_timestamptz(reservation.expires_at) > clock_timestamp()
        ) THEN
          RAISE EXCEPTION 'active secure configuration reservation blocks durable run transition'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_durable_runs_secure_reservation_cancel_guard
        BEFORE UPDATE OF status ON durable_runs
        FOR EACH ROW EXECUTE FUNCTION gc_secure_configuration_durable_run_transition_guard();

      DO $secure_configuration_shape_assertion$
      DECLARE
        expected_column_count CONSTANT BIGINT := 26;
        actual_column_count BIGINT;
        trigger_count BIGINT;
      BEGIN
        SELECT count(*) INTO actual_column_count
        FROM pg_attribute attribute
        WHERE attribute.attrelid = 'chat_turn_secure_configuration_reservations'::regclass
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped;
        IF actual_column_count <> expected_column_count THEN
          RAISE EXCEPTION 'Postgres migration 132 secure configuration column assertion failed: %',
            actual_column_count USING ERRCODE = '23514';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM information_schema.columns actual
          FULL JOIN (
            VALUES
              ('reservation_id', 'text', 'NO'), ('version', 'bigint', 'NO'),
              ('admission_id', 'text', 'NO'), ('session_incarnation_id', 'text', 'NO'),
              ('workspace_id', 'text', 'NO'), ('session_id', 'text', 'NO'),
              ('turn_id', 'text', 'NO'), ('durable_run_id', 'text', 'NO'),
              ('prompt_id', 'text', 'NO'), ('target_id', 'text', 'NO'),
              ('responder_actor_id', 'text', 'NO'), ('responder_auth_actor_source', 'text', 'NO'),
              ('waiting_run_version', 'bigint', 'NO'), ('reserved_run_version', 'bigint', 'NO'),
              ('expires_at', 'text', 'NO'), ('status', 'text', 'NO'),
              ('provider', 'text', 'YES'), ('configuration_revision', 'text', 'YES'),
              ('scope_ref', 'text', 'NO'), ('reserved_at', 'text', 'NO'),
              ('reclaimed_at', 'text', 'YES'), ('completed_at', 'text', 'YES'),
              ('released_at', 'text', 'YES'), ('expired_at', 'text', 'YES'),
              ('reconciled_at', 'text', 'YES'), ('reconciled_by_reservation_id', 'text', 'YES')
          ) expected(column_name, data_type, is_nullable)
            ON actual.column_name = expected.column_name
          WHERE actual.table_schema = current_schema()
            AND actual.table_name = 'chat_turn_secure_configuration_reservations'
            AND (
              expected.column_name IS NULL
              OR actual.data_type IS DISTINCT FROM expected.data_type
              OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
            )
        ) THEN
          RAISE EXCEPTION 'Postgres migration 132 secure configuration column type assertion failed'
            USING ERRCODE = '23514';
        END IF;

        IF EXISTS (
          SELECT 1 FROM chat_turn_secure_configuration_reservations
          WHERE status = 'reserved'
        ) THEN
          RAISE EXCEPTION 'Postgres migration 132 left an ambiguous active secure configuration reservation'
            USING ERRCODE = '23514';
        END IF;

        SELECT count(*) INTO trigger_count
        FROM pg_trigger trigger_row
        WHERE NOT trigger_row.tgisinternal
          AND trigger_row.tgname IN (
            'trg_chat_turn_secure_configuration_reservations_update_guard',
            'trg_chat_turn_secure_configuration_reservations_no_delete',
            'trg_chat_session_mutation_admissions_secure_reservation_close_guard',
            'trg_durable_runs_secure_reservation_cancel_guard'
          )
          AND trigger_row.tgrelid IN (
            'chat_turn_secure_configuration_reservations'::regclass,
            'chat_session_mutation_admissions'::regclass,
            'durable_runs'::regclass
          );
        IF trigger_count <> 4 THEN
          RAISE EXCEPTION 'Postgres migration 132 secure configuration trigger assertion failed: %',
            trigger_count USING ERRCODE = '23514';
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'idx_chat_turn_secure_configuration_one_target_scope'
            AND indexdef ~ 'WHERE \\(status = ''reserved''::text\\)'
        ) THEN
          RAISE EXCEPTION 'Postgres migration 132 secure configuration target-scope index assertion failed'
            USING ERRCODE = '23514';
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint constraint_row
          WHERE constraint_row.conrelid = 'chat_turn_secure_configuration_reservations'::regclass
            AND constraint_row.contype = 'c'
            AND constraint_row.conname = 'chat_turn_secure_configuration_reservations_scope_ref_check'
            AND position('length(btrim(scope_ref))' IN pg_get_constraintdef(constraint_row.oid)) > 0
        ) THEN
          RAISE EXCEPTION 'Postgres migration 132 secure configuration scope_ref constraint assertion failed'
            USING ERRCODE = '23514';
        END IF;

        IF (
          SELECT count(*)
          FROM pg_constraint constraint_row
          WHERE constraint_row.conrelid = 'chat_turn_secure_configuration_reservations'::regclass
            AND constraint_row.contype = 'f'
            AND (
              pg_get_constraintdef(constraint_row.oid) ~
                'FOREIGN KEY \\(admission_id\\) REFERENCES chat_session_mutation_admissions\\(admission_id\\)'
              OR pg_get_constraintdef(constraint_row.oid) ~
                'FOREIGN KEY \\(durable_run_id\\) REFERENCES durable_runs\\(run_id\\)'
              OR pg_get_constraintdef(constraint_row.oid) ~
                'FOREIGN KEY \\(reconciled_by_reservation_id\\) REFERENCES chat_turn_secure_configuration_reservations\\(reservation_id\\)'
            )
        ) <> 3 THEN
          RAISE EXCEPTION 'Postgres migration 132 secure configuration foreign-key assertion failed'
            USING ERRCODE = '23514';
        END IF;
      END;
      $secure_configuration_shape_assertion$;
    `,
  },
  {
    version: 133,
    name: "memory_source_authority_and_trace_candidate_dedupe",
    sql: `
      ALTER TABLE chat_messages
        ADD COLUMN IF NOT EXISTS source_authority TEXT NOT NULL DEFAULT 'unknown';
      UPDATE chat_messages message
      SET source_authority = CASE
        WHEN message.actor_type = 'system' THEN 'trusted_lifecycle'
        WHEN message.role = 'assistant' OR message.actor_type = 'agent' THEN 'agent_proposed'
        WHEN message.role = 'user' AND EXISTS (
          SELECT 1 FROM chat_session_bindings binding
          WHERE binding.session_id = message.session_id AND binding.transport = 'integration'
        ) THEN 'external_channel'
        WHEN message.role = 'user' THEN 'operator'
        ELSE 'unknown'
      END
      WHERE message.source_authority IS NULL OR message.source_authority = 'unknown';

      CREATE TABLE IF NOT EXISTS memory_trace_candidates (
        candidate_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        candidate_type TEXT NOT NULL,
        status TEXT NOT NULL,
        source_text TEXT NOT NULL,
        proposed_insight TEXT NOT NULL,
        confidence DOUBLE PRECISION NOT NULL,
        source_refs_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        authority TEXT NOT NULL,
        actor_id TEXT,
        promoted_learning_id TEXT,
        dedupe_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      ALTER TABLE memory_trace_candidates ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
      UPDATE memory_trace_candidates
      SET dedupe_key = 'legacy:' || candidate_id
      WHERE dedupe_key IS NULL OR length(btrim(dedupe_key)) = 0;
      ALTER TABLE memory_trace_candidates ALTER COLUMN dedupe_key SET NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_trace_candidates_dedupe_key
        ON memory_trace_candidates(dedupe_key);
      CREATE INDEX IF NOT EXISTS idx_memory_trace_candidates_workspace_status
        ON memory_trace_candidates(workspace_id, status);

      CREATE TABLE IF NOT EXISTS memory_authority_migration_reconciliation (
        migration_id TEXT PRIMARY KEY,
        quarantined_count BIGINT NOT NULL,
        recorded_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      WITH quarantined AS (
        UPDATE learned_memory_items item
        SET status = 'disabled',
            disabled_reason = 'external_authority_unverified_migration',
            updated_at = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE item.status = 'active' AND (
          EXISTS (
            SELECT 1 FROM learned_memory_sources source
            WHERE source.item_id = item.item_id AND lower(source.source_kind) IN ('assistant', 'agent')
          )
          OR EXISTS (
            SELECT 1 FROM learned_memory_sources source
            INNER JOIN chat_messages message ON message.message_id = source.source_ref
            WHERE source.item_id = item.item_id
              AND message.source_authority IN ('external_channel', 'unknown', 'agent_proposed')
          )
          OR EXISTS (
            SELECT 1 FROM chat_session_bindings binding
            WHERE binding.session_id = item.session_id AND binding.transport = 'integration'
              AND NOT EXISTS (
                SELECT 1 FROM learned_memory_sources source
                INNER JOIN chat_messages message ON message.message_id = source.source_ref
                WHERE source.item_id = item.item_id AND message.source_authority = 'operator'
              )
          )
        )
        RETURNING item_id
      )
      INSERT INTO memory_authority_migration_reconciliation
        (migration_id, quarantined_count, recorded_at, metadata_json)
      SELECT
        'postgres-133',
        COUNT(*),
        to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        '{"disabledReason":"external_authority_unverified_migration","reversible":true}'
      FROM quarantined
      ON CONFLICT(migration_id) DO UPDATE SET
        quarantined_count = excluded.quarantined_count,
        recorded_at = excluded.recorded_at,
        metadata_json = excluded.metadata_json;
    `,
  },
  {
    version: 134,
    name: "governed_remediation_durable_owner",
    sql: GOVERNED_REMEDIATION_POSTGRES_SCHEMA_SQL,
    integritySha256: "94574755a314cbf1a6f1e285d2d3969d372ec2d3560a1b03d3cfc2b7b85187a5",
  },
  {
    version: 135,
    name: "governed_remediation_recipe_and_phase_authority",
    sql: GOVERNED_REMEDIATION_RECIPE_BINDING_POSTGRES_SQL,
    integritySha256: "27ca84876985f1d8836d4a2b4b441b982652e28ed6642b6afb1f43ffe92aa636",
  },
  {
    version: 136,
    name: "remote_worker_protected_admission_evidence",
    sql: REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_POSTGRES_SQL,
    integritySha256: "6da2dbc1cdb2fbada57fdbaf3573003196ec9702f59519144e501a06ad28463a",
  },
  {
    version: 137,
    name: "remote_worker_mesh_node_admission_authority",
    sql: REMOTE_WORKER_MESH_NODE_ADMISSION_POSTGRES_SQL,
    integritySha256: "2bdbf5518ee1b919a852d8e3e00b98b05ce1f92d2c0563d73c1fb4010d996f97",
  },
  {
    version: 138,
    name: "mobile_push_registration_and_delivery_owner",
    sql: MOBILE_PUSH_POSTGRES_SCHEMA_SQL,
    integritySha256: "b4f7a5cbfb59f358fd765207b9a36264372e5f51a82ef25bb191b0169bc470a1",
  },
  {
    version: 139,
    name: "remote_worker_inference_budget_authority_correction",
    integritySha256: "2b05393513f6695c8ae8f958989630c8aadf1debff61c3e33ce5993bc532bf68",
    sql: `
      DO $rename_legacy_budget$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'remote_worker_inference_requests'
            AND column_name = 'budget_reservation_id'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'remote_worker_inference_requests'
            AND column_name = 'legacy_budget_reservation_marker'
        ) THEN
          ALTER TABLE remote_worker_inference_requests
            RENAME COLUMN budget_reservation_id TO legacy_budget_reservation_marker;
        END IF;
      END
      $rename_legacy_budget$;

      ALTER TABLE remote_worker_inference_requests
        ADD COLUMN IF NOT EXISTS execution_workspace_id TEXT,
        ADD COLUMN IF NOT EXISTS durable_run_id TEXT,
        ADD COLUMN IF NOT EXISTS task_id TEXT,
        ADD COLUMN IF NOT EXISTS admitted_lease_revision BIGINT,
        ADD COLUMN IF NOT EXISTS effective_route_json TEXT,
        ADD COLUMN IF NOT EXISTS approval_resolution_json TEXT,
        ADD COLUMN IF NOT EXISTS approval_resolution_sha256 TEXT,
        ADD COLUMN IF NOT EXISTS approval_resolved_at TEXT,
        ADD COLUMN IF NOT EXISTS continuation_governance_json TEXT,
        ADD COLUMN IF NOT EXISTS continuation_governance_sha256 TEXT,
        ADD COLUMN IF NOT EXISTS continuation_governance_expires_at TEXT,
        ADD COLUMN IF NOT EXISTS budget_authority_state TEXT NOT NULL DEFAULT 'legacy_unverifiable',
        ADD COLUMN IF NOT EXISTS budget_operation_id TEXT,
        ADD COLUMN IF NOT EXISTS budget_operation_json TEXT,
        ADD COLUMN IF NOT EXISTS budget_operation_sha256 TEXT,
        ADD COLUMN IF NOT EXISTS budget_reservation_id TEXT,
        ADD COLUMN IF NOT EXISTS budget_reservation_json TEXT,
        ADD COLUMN IF NOT EXISTS budget_reservation_sha256 TEXT,
        ADD COLUMN IF NOT EXISTS budget_reservation_expires_at TEXT,
        ADD COLUMN IF NOT EXISTS usage_event_ids_json TEXT,
        ADD COLUMN IF NOT EXISTS usage_event_ids_sha256 TEXT,
        ADD COLUMN IF NOT EXISTS budget_settled_at TEXT,
        ADD COLUMN IF NOT EXISTS budget_released_at TEXT,
        ADD COLUMN IF NOT EXISTS block_reason TEXT;

      CREATE INDEX IF NOT EXISTS idx_remote_worker_inference_budget_recovery
        ON remote_worker_inference_requests(budget_authority_state, updated_at)
        WHERE budget_authority_state IN ('settlement_pending', 'reserved', 'reconciliation_required');

      CREATE OR REPLACE FUNCTION gc_remote_worker_inference_budget_authority_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.budget_authority_state NOT IN (
          'not_required', 'reservation_pending', 'reserved', 'settlement_pending',
          'settled', 'released', 'reconciliation_required', 'legacy_unverifiable'
        )
          OR (
            NEW.budget_authority_state <> 'legacy_unverifiable'
            AND (
              NEW.execution_workspace_id IS NULL OR NEW.durable_run_id IS NULL OR NEW.task_id IS NULL
              OR NEW.admitted_lease_revision IS NULL
            )
          )
          OR (
            NEW.budget_authority_state = 'not_required'
            AND (NEW.budget_reservation_id IS NOT NULL OR NEW.budget_reservation_json IS NOT NULL)
          )
          OR (
            NEW.budget_authority_state = 'reservation_pending'
            AND (
              NEW.state <> 'admitted' OR NEW.budget_operation_id IS NULL OR NEW.budget_operation_json IS NULL
              OR NEW.budget_operation_sha256 IS NULL OR NEW.effective_route_json IS NULL
              OR NEW.budget_reservation_id IS NOT NULL
            )
          )
          OR (
            NEW.budget_authority_state IN ('reserved', 'settlement_pending', 'settled', 'released', 'reconciliation_required')
            AND (
              NEW.budget_operation_id IS NULL OR NEW.budget_operation_json IS NULL OR NEW.budget_operation_sha256 IS NULL
              OR NEW.budget_reservation_id IS NULL OR NEW.budget_reservation_json IS NULL
              OR NEW.budget_reservation_sha256 IS NULL OR NEW.budget_reservation_expires_at IS NULL
            )
          )
          OR (NEW.budget_authority_state = 'reserved' AND NEW.state NOT IN ('admitted', 'dispatch_claimed', 'streaming', 'blocked'))
          OR (
            NEW.budget_authority_state IN ('settlement_pending', 'settled')
            AND (
              NEW.state NOT IN ('completed', 'failed', 'cancelled')
              OR NEW.usage_event_ids_json IS NULL OR NEW.usage_event_ids_sha256 IS NULL
            )
          )
          OR (NEW.budget_authority_state = 'settled' AND NEW.budget_settled_at IS NULL)
          OR (NEW.budget_authority_state = 'released' AND (NEW.state <> 'blocked' OR NEW.budget_released_at IS NULL))
          OR (NEW.budget_authority_state = 'reconciliation_required' AND NEW.state <> 'dispatch_unknown')
          OR (NEW.state IN ('dispatch_claimed', 'streaming') AND NEW.budget_authority_state <> 'reserved') THEN
          RAISE EXCEPTION 'remote worker inference budget authority evidence is incomplete' USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'UPDATE'
          AND OLD.budget_authority_state = 'legacy_unverifiable'
          AND NEW.budget_authority_state IS DISTINCT FROM OLD.budget_authority_state THEN
          RAISE EXCEPTION 'remote worker inference legacy budget evidence is unverifiable' USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.state = 'waiting_approval' AND NEW.state = 'admitted'
          AND (
            NEW.approval_resolution_json IS NULL OR NEW.approval_resolution_sha256 IS NULL
            OR NEW.approval_resolved_at IS NULL OR NEW.continuation_governance_json IS NULL
            OR NEW.continuation_governance_sha256 IS NULL OR NEW.continuation_governance_expires_at IS NULL
            OR NEW.budget_authority_state <> 'reservation_pending'
          ) THEN
          RAISE EXCEPTION 'remote worker inference approval continuation evidence is incomplete' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_remote_worker_inference_v2_authority_immutable_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.legacy_budget_reservation_marker IS DISTINCT FROM OLD.legacy_budget_reservation_marker
          OR NEW.execution_workspace_id IS DISTINCT FROM OLD.execution_workspace_id
          OR NEW.durable_run_id IS DISTINCT FROM OLD.durable_run_id
          OR NEW.task_id IS DISTINCT FROM OLD.task_id
          OR NEW.admitted_lease_revision IS DISTINCT FROM OLD.admitted_lease_revision
          OR (OLD.effective_route_json IS NOT NULL AND NEW.effective_route_json IS DISTINCT FROM OLD.effective_route_json)
          OR (OLD.approval_resolution_json IS NOT NULL AND NEW.approval_resolution_json IS DISTINCT FROM OLD.approval_resolution_json)
          OR (OLD.approval_resolution_sha256 IS NOT NULL AND NEW.approval_resolution_sha256 IS DISTINCT FROM OLD.approval_resolution_sha256)
          OR (OLD.approval_resolved_at IS NOT NULL AND NEW.approval_resolved_at IS DISTINCT FROM OLD.approval_resolved_at)
          OR (OLD.continuation_governance_json IS NOT NULL AND NEW.continuation_governance_json IS DISTINCT FROM OLD.continuation_governance_json)
          OR (OLD.continuation_governance_sha256 IS NOT NULL AND NEW.continuation_governance_sha256 IS DISTINCT FROM OLD.continuation_governance_sha256)
          OR (OLD.continuation_governance_expires_at IS NOT NULL AND NEW.continuation_governance_expires_at IS DISTINCT FROM OLD.continuation_governance_expires_at)
          OR (OLD.budget_operation_id IS NOT NULL AND NEW.budget_operation_id IS DISTINCT FROM OLD.budget_operation_id)
          OR (OLD.budget_operation_json IS NOT NULL AND NEW.budget_operation_json IS DISTINCT FROM OLD.budget_operation_json)
          OR (OLD.budget_operation_sha256 IS NOT NULL AND NEW.budget_operation_sha256 IS DISTINCT FROM OLD.budget_operation_sha256)
          OR (OLD.budget_reservation_id IS NOT NULL AND NEW.budget_reservation_id IS DISTINCT FROM OLD.budget_reservation_id)
          OR (OLD.budget_reservation_json IS NOT NULL AND NEW.budget_reservation_json IS DISTINCT FROM OLD.budget_reservation_json)
          OR (OLD.budget_reservation_sha256 IS NOT NULL AND NEW.budget_reservation_sha256 IS DISTINCT FROM OLD.budget_reservation_sha256)
          OR (OLD.budget_reservation_expires_at IS NOT NULL AND NEW.budget_reservation_expires_at IS DISTINCT FROM OLD.budget_reservation_expires_at)
          OR (OLD.usage_event_ids_json IS NOT NULL AND NEW.usage_event_ids_json IS DISTINCT FROM OLD.usage_event_ids_json)
          OR (OLD.usage_event_ids_sha256 IS NOT NULL AND NEW.usage_event_ids_sha256 IS DISTINCT FROM OLD.usage_event_ids_sha256)
          OR (OLD.budget_settled_at IS NOT NULL AND NEW.budget_settled_at IS DISTINCT FROM OLD.budget_settled_at)
          OR (OLD.budget_released_at IS NOT NULL AND NEW.budget_released_at IS DISTINCT FROM OLD.budget_released_at)
          OR (OLD.block_reason IS NOT NULL AND NEW.block_reason IS DISTINCT FROM OLD.block_reason)
          OR (
            OLD.budget_authority_state = 'legacy_unverifiable'
            AND (
              NEW.effective_route_json IS DISTINCT FROM OLD.effective_route_json
              OR NEW.approval_resolution_json IS DISTINCT FROM OLD.approval_resolution_json
              OR NEW.approval_resolution_sha256 IS DISTINCT FROM OLD.approval_resolution_sha256
              OR NEW.approval_resolved_at IS DISTINCT FROM OLD.approval_resolved_at
              OR NEW.continuation_governance_json IS DISTINCT FROM OLD.continuation_governance_json
              OR NEW.continuation_governance_sha256 IS DISTINCT FROM OLD.continuation_governance_sha256
              OR NEW.continuation_governance_expires_at IS DISTINCT FROM OLD.continuation_governance_expires_at
              OR NEW.budget_operation_id IS DISTINCT FROM OLD.budget_operation_id
              OR NEW.budget_operation_json IS DISTINCT FROM OLD.budget_operation_json
              OR NEW.budget_operation_sha256 IS DISTINCT FROM OLD.budget_operation_sha256
              OR NEW.budget_reservation_id IS DISTINCT FROM OLD.budget_reservation_id
              OR NEW.budget_reservation_json IS DISTINCT FROM OLD.budget_reservation_json
              OR NEW.budget_reservation_sha256 IS DISTINCT FROM OLD.budget_reservation_sha256
              OR NEW.budget_reservation_expires_at IS DISTINCT FROM OLD.budget_reservation_expires_at
              OR NEW.usage_event_ids_json IS DISTINCT FROM OLD.usage_event_ids_json
              OR NEW.usage_event_ids_sha256 IS DISTINCT FROM OLD.usage_event_ids_sha256
              OR NEW.budget_settled_at IS DISTINCT FROM OLD.budget_settled_at
              OR NEW.budget_released_at IS DISTINCT FROM OLD.budget_released_at
            )
          ) THEN
          RAISE EXCEPTION 'remote worker inference v2 authority evidence is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION gc_remote_worker_inference_request_terminal_guard()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.state IN ('completed', 'failed', 'cancelled', 'dispatch_unknown', 'blocked')
          AND (
            NEW.state IS DISTINCT FROM OLD.state
            OR NEW.dispatch_claim_owner IS DISTINCT FROM OLD.dispatch_claim_owner
            OR NEW.dispatch_lease_expires_at IS DISTINCT FROM OLD.dispatch_lease_expires_at
            OR NEW.effective_provider_id IS DISTINCT FROM OLD.effective_provider_id
            OR NEW.effective_model_id IS DISTINCT FROM OLD.effective_model_id
            OR NEW.usage_terminal_event_id IS DISTINCT FROM OLD.usage_terminal_event_id
            OR NEW.output_frame_count IS DISTINCT FROM OLD.output_frame_count
            OR NEW.output_char_count IS DISTINCT FROM OLD.output_char_count
            OR NEW.worker_acknowledged_through < OLD.worker_acknowledged_through
          ) THEN
          RAISE EXCEPTION 'remote worker inference terminal state is immutable except recovery and acknowledgement' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_remote_worker_inference_budget_authority_guard ON remote_worker_inference_requests;
      CREATE TRIGGER trg_remote_worker_inference_budget_authority_guard
        BEFORE INSERT OR UPDATE ON remote_worker_inference_requests
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_inference_budget_authority_guard();
      DROP TRIGGER IF EXISTS trg_remote_worker_inference_v2_authority_immutable ON remote_worker_inference_requests;
      CREATE TRIGGER trg_remote_worker_inference_v2_authority_immutable
        BEFORE UPDATE ON remote_worker_inference_requests
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_inference_v2_authority_immutable_guard();
    `,
  },
];

function buildWorkspacePathBridgePosixFlavorPostgresSql(): string {
  const widen = (table: string, column: string) => `
      DO $posix_flavor$
      DECLARE
        frozen_constraint TEXT;
      BEGIN
        IF to_regclass('public.${table}') IS NULL THEN
          RETURN;
        END IF;
        FOR frozen_constraint IN
          SELECT conname
          FROM pg_constraint
          WHERE conrelid = 'public.${table}'::regclass
            AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%${column}%'
            AND pg_get_constraintdef(oid) LIKE '%windows_native%'
            AND pg_get_constraintdef(oid) NOT LIKE '%posix%'
            -- The paired wsl/distro CHECK also names the flavor columns; it is
            -- unaffected by the widened domain and must survive untouched.
            AND pg_get_constraintdef(oid) NOT LIKE '%distro%'
        LOOP
          EXECUTE format('ALTER TABLE public.${table} DROP CONSTRAINT %I', frozen_constraint);
        END LOOP;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.${table}'::regclass
            AND conname = '${table}_${column}_posix_check'
        ) THEN
          ALTER TABLE public.${table}
            ADD CONSTRAINT ${table}_${column}_posix_check
            CHECK(${column} IN ('windows_native', 'windows_forward', 'msys', 'wsl', 'posix'));
        END IF;
      END
      $posix_flavor$;
  `;
  return [
    widen("workspace_path_bridge_snapshots", "input_flavor"),
    widen("workspace_path_bridge_snapshots", "target_flavor"),
    widen("external_source_configs", "input_flavor"),
    widen("external_source_configs", "target_flavor"),
  ].join("\n");
}

function buildRemoteWorkerSettlementPostgresSql(): string {
  const identity = `
        registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
        execution_workspace_id TEXT NOT NULL CHECK(length(execution_workspace_id) BETWEEN 1 AND 256),
        assignment_id TEXT NOT NULL CHECK(length(assignment_id) BETWEEN 1 AND 256),
        assignment_generation BIGINT NOT NULL CHECK(assignment_generation > 0),
        worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
        worker_generation BIGINT NOT NULL CHECK(worker_generation > 0),
        runtime_manifest_sha256 TEXT NOT NULL CHECK(runtime_manifest_sha256 ~ '^[0-9a-f]{64}$'),
        workspace_ceiling_sha256 TEXT NOT NULL CHECK(workspace_ceiling_sha256 ~ '^[0-9a-f]{64}$'),
        capability_ceiling_sha256 TEXT NOT NULL CHECK(capability_ceiling_sha256 ~ '^[0-9a-f]{64}$'),
        assignment_manifest_sha256 TEXT NOT NULL CHECK(assignment_manifest_sha256 ~ '^[0-9a-f]{64}$')`;
  const fullIdentityFk = `
        FOREIGN KEY(
          registry_workspace_id, assignment_id, assignment_generation, execution_workspace_id, worker_id,
          worker_generation, runtime_manifest_sha256, workspace_ceiling_sha256, capability_ceiling_sha256
        ) REFERENCES remote_worker_assignment_generations(
          registry_workspace_id, assignment_id, assignment_generation, execution_workspace_id, worker_id,
          worker_generation, runtime_manifest_sha256, workspace_ceiling_sha256, capability_ceiling_sha256
        ) ON DELETE RESTRICT`;
  const timestamp = (column: string): string => `
        ${column} TEXT NOT NULL CHECK(
          gc_try_parse_timestamptz(${column}) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(${column}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = ${column}
        )`;
  const nullableTimestamp = (column: string): string => `
        ${column} TEXT CHECK(${column} IS NULL OR (
          gc_try_parse_timestamptz(${column}) IS NOT NULL
          AND to_char(gc_try_parse_timestamptz(${column}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = ${column}
        ))`;
  const insertOnly = (table: string, label: string): string => `
      CREATE OR REPLACE FUNCTION gc_reject_${table}_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION '${label} is insert-only' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_${table}_no_update ON ${table};
      CREATE TRIGGER trg_${table}_no_update BEFORE UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION gc_reject_${table}_mutation();
      DROP TRIGGER IF EXISTS trg_${table}_no_delete ON ${table};
      CREATE TRIGGER trg_${table}_no_delete BEFORE DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION gc_reject_${table}_mutation();`;
  const bindAssignmentManifest = (table: string): string => `
      CREATE OR REPLACE FUNCTION gc_${table}_assignment_manifest_guard()
      RETURNS trigger AS $$
      DECLARE parent_manifest TEXT;
      BEGIN
        SELECT a.manifest_sha256 INTO parent_manifest FROM remote_worker_assignments a
          WHERE a.registry_workspace_id = NEW.registry_workspace_id AND a.assignment_id = NEW.assignment_id;
        IF NEW.assignment_manifest_sha256 IS DISTINCT FROM parent_manifest THEN
          RAISE EXCEPTION '${table} assignment manifest hash must bind the parent assignment' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_${table}_assignment_manifest_bound ON ${table};
      CREATE TRIGGER trg_${table}_assignment_manifest_bound BEFORE INSERT ON ${table}
        FOR EACH ROW EXECUTE FUNCTION gc_${table}_assignment_manifest_guard();`;
  const zero = "0".repeat(64);

  return `
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM remote_worker_assignment_settlements
          WHERE outcome = 'completed' AND output_manifest_sha256 IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'PostgreSQL migration 121 cannot prove an existing completed remote-worker settlement against a canonical HX-506 manifest' USING ERRCODE = '23514';
        END IF;
      END $$;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_worker_assignment_generations_full_identity
        ON remote_worker_assignment_generations(
          registry_workspace_id, assignment_id, assignment_generation, execution_workspace_id, worker_id,
          worker_generation, runtime_manifest_sha256, workspace_ceiling_sha256, capability_ceiling_sha256
        );

      CREATE TABLE IF NOT EXISTS remote_worker_artifact_uploads (${identity},
        upload_id TEXT NOT NULL CHECK(length(upload_id) BETWEEN 1 AND 256),
        upload_attempt BIGINT NOT NULL CHECK(upload_attempt BETWEEN 1 AND 4),
        upload_state TEXT NOT NULL CHECK(upload_state IN ('open', 'assembling', 'committed', 'abandoned', 'quarantined')),
        upload_revision BIGINT NOT NULL CHECK(upload_revision > 0),
        declared_file_count BIGINT NOT NULL CHECK(declared_file_count BETWEEN 0 AND 64),
        declared_total_bytes BIGINT NOT NULL CHECK(declared_total_bytes BETWEEN 0 AND 67108864),
        max_artifact_bytes BIGINT NOT NULL CHECK(max_artifact_bytes BETWEEN 1 AND 67108864),
        staging_root_sha256 TEXT NOT NULL CHECK(staging_root_sha256 ~ '^[0-9a-f]{64}$'),
        committed_manifest_sha256 TEXT CHECK(committed_manifest_sha256 IS NULL OR committed_manifest_sha256 ~ '^[0-9a-f]{64}$'),
        verification_gate_state TEXT CHECK(verification_gate_state IS NULL OR verification_gate_state IN ('not_required', 'pending', 'satisfied')),
        verification_gate_revision BIGINT NOT NULL DEFAULT 0 CHECK(verification_gate_revision BETWEEN 0 AND 100000),
        cleanup_state TEXT NOT NULL CHECK(cleanup_state IN ('not_due', 'pending', 'cleaned', 'manual_reconciliation')),
        cleanup_revision BIGINT NOT NULL CHECK(cleanup_revision > 0),
        cleanup_claim_owner TEXT CHECK(cleanup_claim_owner IS NULL OR length(cleanup_claim_owner) BETWEEN 1 AND 256),${nullableTimestamp("cleanup_claim_expires_at")},${timestamp("expires_at")},
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),${timestamp("created_at")},${timestamp("updated_at")},
        PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, upload_id),
        UNIQUE(registry_workspace_id, idempotency_key),
        UNIQUE(registry_workspace_id, assignment_id, assignment_generation, upload_attempt),
        UNIQUE(registry_workspace_id, assignment_id, assignment_generation, upload_id, assignment_manifest_sha256),
        ${fullIdentityFk},
        CHECK(declared_total_bytes <= max_artifact_bytes),
        CHECK((cleanup_claim_owner IS NULL) = (cleanup_claim_expires_at IS NULL)),
        CHECK(upload_state = 'committed' OR (committed_manifest_sha256 IS NULL AND verification_gate_state IS NULL)),
        CHECK(upload_state <> 'committed' OR (committed_manifest_sha256 IS NOT NULL AND verification_gate_state IS NOT NULL))
      );

      CREATE TABLE IF NOT EXISTS remote_worker_artifact_parts (${identity},
        upload_id TEXT NOT NULL CHECK(length(upload_id) BETWEEN 1 AND 256),
        global_sequence BIGINT NOT NULL CHECK(global_sequence BETWEEN 1 AND 320),
        logical_path_sha256 TEXT NOT NULL CHECK(logical_path_sha256 ~ '^[0-9a-f]{64}$'),
        file_part_index BIGINT NOT NULL CHECK(file_part_index BETWEEN 0 AND 319),
        is_final_part BIGINT NOT NULL CHECK(is_final_part IN (0, 1)),
        part_bytes BIGINT NOT NULL CHECK(part_bytes BETWEEN 1 AND 262144),
        part_sha256 TEXT NOT NULL CHECK(part_sha256 ~ '^[0-9a-f]{64}$'),
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),${timestamp("received_at")},
        PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, upload_id, global_sequence),
        UNIQUE(registry_workspace_id, idempotency_key),
        FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation, upload_id, assignment_manifest_sha256)
          REFERENCES remote_worker_artifact_uploads(registry_workspace_id, assignment_id, assignment_generation, upload_id, assignment_manifest_sha256) ON DELETE RESTRICT,
        ${fullIdentityFk},
        CHECK(is_final_part = 1 OR part_bytes = 262144)
      );

      CREATE TABLE IF NOT EXISTS remote_worker_artifact_blobs (${identity},
        upload_id TEXT NOT NULL CHECK(length(upload_id) BETWEEN 1 AND 256),
        blob_sha256 TEXT NOT NULL CHECK(blob_sha256 ~ '^[0-9a-f]{64}$'),
        byte_count BIGINT NOT NULL CHECK(byte_count BETWEEN 0 AND 67108864),
        physical_rel_path TEXT NOT NULL CHECK(length(physical_rel_path) BETWEEN 1 AND 512 AND physical_rel_path LIKE 'remote-workers/artifacts/%'),${timestamp("installed_at")},
        PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, blob_sha256),
        UNIQUE(registry_workspace_id, assignment_id, assignment_generation, blob_sha256, assignment_manifest_sha256),
        FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation, upload_id, assignment_manifest_sha256)
          REFERENCES remote_worker_artifact_uploads(registry_workspace_id, assignment_id, assignment_generation, upload_id, assignment_manifest_sha256) ON DELETE RESTRICT,
        ${fullIdentityFk}
      );

      CREATE TABLE IF NOT EXISTS remote_worker_artifact_manifests (${identity},
        upload_id TEXT NOT NULL CHECK(length(upload_id) BETWEEN 1 AND 256),
        manifest_id TEXT NOT NULL CHECK(length(manifest_id) BETWEEN 1 AND 256),
        manifest_sha256 TEXT NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
        manifest_json TEXT NOT NULL CHECK(jsonb_typeof(manifest_json::jsonb) = 'object' AND octet_length(manifest_json) <= 65536),
        file_count BIGINT NOT NULL CHECK(file_count BETWEEN 0 AND 64),
        total_bytes BIGINT NOT NULL CHECK(total_bytes BETWEEN 0 AND 67108864),
        path_jail_sha256 TEXT NOT NULL CHECK(path_jail_sha256 ~ '^[0-9a-f]{64}$'),
        worker_claim_sha256 TEXT NOT NULL CHECK(worker_claim_sha256 ~ '^[0-9a-f]{64}$'),
        required_verifier_profile_sha256 TEXT CHECK(required_verifier_profile_sha256 IS NULL OR required_verifier_profile_sha256 ~ '^[0-9a-f]{64}$'),
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),${timestamp("committed_at")},
        PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, manifest_id),
        UNIQUE(registry_workspace_id, assignment_id, assignment_generation),
        UNIQUE(registry_workspace_id, manifest_sha256),
        UNIQUE(registry_workspace_id, idempotency_key),
        UNIQUE(registry_workspace_id, assignment_id, assignment_generation, manifest_id, assignment_manifest_sha256),
        FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation, upload_id, assignment_manifest_sha256)
          REFERENCES remote_worker_artifact_uploads(registry_workspace_id, assignment_id, assignment_generation, upload_id, assignment_manifest_sha256) ON DELETE RESTRICT,
        ${fullIdentityFk},
        CHECK(manifest_json::jsonb ->> 'schemaVersion' = 'goatcitadel.remote-worker-artifact-manifest.v1')
      );

      CREATE TABLE IF NOT EXISTS remote_worker_artifact_manifest_entries (${identity},
        manifest_id TEXT NOT NULL CHECK(length(manifest_id) BETWEEN 1 AND 256),
        entry_index BIGINT NOT NULL CHECK(entry_index BETWEEN 0 AND 63),
        logical_path TEXT NOT NULL CHECK(octet_length(logical_path) BETWEEN 1 AND 512),
        logical_path_sha256 TEXT NOT NULL CHECK(logical_path_sha256 ~ '^[0-9a-f]{64}$'),
        blob_sha256 TEXT NOT NULL CHECK(blob_sha256 ~ '^[0-9a-f]{64}$'),
        byte_count BIGINT NOT NULL CHECK(byte_count BETWEEN 0 AND 67108864),
        mime_type TEXT NOT NULL CHECK(length(mime_type) BETWEEN 1 AND 128),
        PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, manifest_id, entry_index),
        UNIQUE(registry_workspace_id, assignment_id, assignment_generation, manifest_id, logical_path_sha256),
        FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation, manifest_id, assignment_manifest_sha256)
          REFERENCES remote_worker_artifact_manifests(registry_workspace_id, assignment_id, assignment_generation, manifest_id, assignment_manifest_sha256) ON DELETE RESTRICT,
        FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation, blob_sha256, assignment_manifest_sha256)
          REFERENCES remote_worker_artifact_blobs(registry_workspace_id, assignment_id, assignment_generation, blob_sha256, assignment_manifest_sha256) ON DELETE RESTRICT,
        ${fullIdentityFk}
      );

      CREATE TABLE IF NOT EXISTS remote_worker_artifact_verifications (${identity},
        manifest_id TEXT NOT NULL CHECK(length(manifest_id) BETWEEN 1 AND 256),
        verification_id TEXT NOT NULL CHECK(length(verification_id) BETWEEN 1 AND 256),
        kind TEXT NOT NULL CHECK(kind IN ('worker_claim', 'gateway_attempt')),
        attempt_index BIGINT NOT NULL CHECK(attempt_index BETWEEN 1 AND 16),
        attempt_state TEXT NOT NULL CHECK(attempt_state IN ('worker_reported', 'queued', 'running', 'passed', 'failed', 'indeterminate', 'blocked')),
        attempt_revision BIGINT NOT NULL CHECK(attempt_revision > 0),
        verifier_profile_sha256 TEXT CHECK(verifier_profile_sha256 IS NULL OR verifier_profile_sha256 ~ '^[0-9a-f]{64}$'),
        evidence_json TEXT NOT NULL CHECK(jsonb_typeof(evidence_json::jsonb) = 'object' AND octet_length(evidence_json) <= 16384),
        evidence_sha256 TEXT NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
        claim_owner TEXT CHECK(claim_owner IS NULL OR length(claim_owner) BETWEEN 1 AND 256),${nullableTimestamp("claim_expires_at")},${nullableTimestamp("wall_deadline_at")},
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),${timestamp("created_at")},${timestamp("updated_at")},
        PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, manifest_id, verification_id),
        UNIQUE(registry_workspace_id, idempotency_key),
        UNIQUE(registry_workspace_id, assignment_id, assignment_generation, manifest_id, kind, attempt_index),
        FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation, manifest_id, assignment_manifest_sha256)
          REFERENCES remote_worker_artifact_manifests(registry_workspace_id, assignment_id, assignment_generation, manifest_id, assignment_manifest_sha256) ON DELETE RESTRICT,
        ${fullIdentityFk},
        CHECK(
          (kind = 'worker_claim' AND attempt_state = 'worker_reported' AND verifier_profile_sha256 IS NULL)
          OR (kind = 'gateway_attempt' AND attempt_state <> 'worker_reported' AND verifier_profile_sha256 IS NOT NULL)
        ),
        CHECK((claim_owner IS NULL) = (claim_expires_at IS NULL))
      );

      CREATE TABLE IF NOT EXISTS remote_worker_effect_intents (${identity},
        intent_id TEXT NOT NULL CHECK(length(intent_id) BETWEEN 1 AND 256),
        intent_index BIGINT NOT NULL CHECK(intent_index BETWEEN 0 AND 63),
        effect_selector TEXT NOT NULL CHECK(octet_length(effect_selector) BETWEEN 1 AND 256),
        canonical_args_json TEXT NOT NULL CHECK(jsonb_typeof(canonical_args_json::jsonb) IS NOT NULL AND octet_length(canonical_args_json) <= 65536),
        canonical_args_sha256 TEXT NOT NULL CHECK(canonical_args_sha256 ~ '^[0-9a-f]{64}$'),
        intent_sha256 TEXT NOT NULL CHECK(intent_sha256 ~ '^[0-9a-f]{64}$'),
        worker_idempotency_key TEXT NOT NULL CHECK(length(worker_idempotency_key) BETWEEN 1 AND 512),
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),${timestamp("recorded_at")},
        PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, intent_id),
        UNIQUE(registry_workspace_id, idempotency_key),
        UNIQUE(registry_workspace_id, intent_sha256),
        UNIQUE(registry_workspace_id, assignment_id, assignment_generation, intent_index),
        UNIQUE(registry_workspace_id, assignment_id, assignment_generation, intent_id, assignment_manifest_sha256),
        ${fullIdentityFk}
      );

      CREATE TABLE IF NOT EXISTS remote_worker_effect_transitions (${identity},
        intent_id TEXT NOT NULL CHECK(length(intent_id) BETWEEN 1 AND 256),
        transition_sequence BIGINT NOT NULL CHECK(transition_sequence BETWEEN 1 AND 16),
        transition_state TEXT NOT NULL CHECK(transition_state IN (
          'recorded', 'approval_wait', 'dispatch_claimed', 'external_boundary_started',
          'blocked_before_dispatch', 'failed_before_boundary', 'completed_no_effect',
          'completed_with_effect', 'manual_reconciliation', 'manual_reconciliation_resolved'
        )),
        correlation_json TEXT NOT NULL CHECK(jsonb_typeof(correlation_json::jsonb) = 'object' AND octet_length(correlation_json) <= 16384),
        correlation_sha256 TEXT NOT NULL CHECK(correlation_sha256 ~ '^[0-9a-f]{64}$'),
        external_side_effect_run_id TEXT CHECK(external_side_effect_run_id IS NULL OR length(external_side_effect_run_id) BETWEEN 1 AND 256),
        hx305_outcome_sha256 TEXT CHECK(hx305_outcome_sha256 IS NULL OR hx305_outcome_sha256 ~ '^[0-9a-f]{64}$'),
        previous_transition_sha256 TEXT NOT NULL CHECK(previous_transition_sha256 ~ '^[0-9a-f]{64}$'),
        transition_sha256 TEXT NOT NULL CHECK(transition_sha256 ~ '^[0-9a-f]{64}$'),
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),${timestamp("recorded_at")},
        PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, intent_id, transition_sequence),
        UNIQUE(registry_workspace_id, idempotency_key),
        UNIQUE(registry_workspace_id, transition_sha256),
        FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation, intent_id, assignment_manifest_sha256)
          REFERENCES remote_worker_effect_intents(registry_workspace_id, assignment_id, assignment_generation, intent_id, assignment_manifest_sha256) ON DELETE RESTRICT,
        ${fullIdentityFk},
        CHECK(correlation_json::jsonb ->> 'transitionState' = transition_state),
        CHECK(transition_state <> 'completed_with_effect' OR hx305_outcome_sha256 IS NOT NULL)
      );

      CREATE TABLE IF NOT EXISTS remote_worker_effect_receipts (${identity},
        intent_id TEXT NOT NULL CHECK(length(intent_id) BETWEEN 1 AND 256),
        receipt_state TEXT NOT NULL CHECK(receipt_state IN (
          'blocked_before_dispatch', 'failed_before_boundary', 'completed_no_effect',
          'completed_with_effect', 'manual_reconciliation'
        )),
        receipt_revision BIGINT NOT NULL CHECK(receipt_revision > 0),
        final_transition_sequence BIGINT NOT NULL CHECK(final_transition_sequence BETWEEN 1 AND 16),
        final_transition_sha256 TEXT NOT NULL CHECK(final_transition_sha256 ~ '^[0-9a-f]{64}$'),
        hx305_outcome_sha256 TEXT CHECK(hx305_outcome_sha256 IS NULL OR hx305_outcome_sha256 ~ '^[0-9a-f]{64}$'),
        reconciliation_record_sha256 TEXT CHECK(reconciliation_record_sha256 IS NULL OR reconciliation_record_sha256 ~ '^[0-9a-f]{64}$'),
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),${timestamp("created_at")},${timestamp("updated_at")},
        PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, intent_id),
        UNIQUE(registry_workspace_id, idempotency_key),
        FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation, intent_id, assignment_manifest_sha256)
          REFERENCES remote_worker_effect_intents(registry_workspace_id, assignment_id, assignment_generation, intent_id, assignment_manifest_sha256) ON DELETE RESTRICT,
        ${fullIdentityFk},
        CHECK(receipt_state <> 'completed_with_effect' OR hx305_outcome_sha256 IS NOT NULL)
      );

      CREATE INDEX IF NOT EXISTS idx_remote_worker_artifact_parts_chain
        ON remote_worker_artifact_parts(registry_workspace_id, assignment_id, assignment_generation, upload_id, global_sequence);
      CREATE INDEX IF NOT EXISTS idx_remote_worker_effect_transitions_chain
        ON remote_worker_effect_transitions(registry_workspace_id, assignment_id, assignment_generation, intent_id, transition_sequence);

      ${bindAssignmentManifest("remote_worker_artifact_uploads")}
      ${bindAssignmentManifest("remote_worker_effect_intents")}

      ${insertOnly("remote_worker_artifact_parts", "remote worker artifact part")}
      ${insertOnly("remote_worker_artifact_blobs", "remote worker artifact blob")}
      ${insertOnly("remote_worker_artifact_manifests", "remote worker artifact manifest")}
      ${insertOnly("remote_worker_artifact_manifest_entries", "remote worker artifact manifest entry")}
      ${insertOnly("remote_worker_effect_intents", "remote worker effect intent")}
      ${insertOnly("remote_worker_effect_transitions", "remote worker effect transition")}

      CREATE OR REPLACE FUNCTION gc_remote_worker_artifact_parts_sequence_guard()
      RETURNS trigger AS $$
      DECLARE expected_sequence BIGINT; parent_state TEXT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(
          NEW.registry_workspace_id || ':' || NEW.assignment_id || ':' || NEW.assignment_generation::text || ':' || NEW.upload_id, 506
        ));
        SELECT 1 + COALESCE(MAX(p.global_sequence), 0) INTO expected_sequence
          FROM remote_worker_artifact_parts p
          WHERE p.registry_workspace_id = NEW.registry_workspace_id AND p.assignment_id = NEW.assignment_id
            AND p.assignment_generation = NEW.assignment_generation AND p.upload_id = NEW.upload_id;
        SELECT u.upload_state INTO parent_state FROM remote_worker_artifact_uploads u
          WHERE u.registry_workspace_id = NEW.registry_workspace_id AND u.assignment_id = NEW.assignment_id
            AND u.assignment_generation = NEW.assignment_generation AND u.upload_id = NEW.upload_id;
        IF NEW.global_sequence <> expected_sequence THEN
          RAISE EXCEPTION 'remote worker artifact part sequence must be globally contiguous' USING ERRCODE = '23514';
        END IF;
        IF parent_state IS DISTINCT FROM 'open' AND parent_state IS DISTINCT FROM 'assembling' THEN
          RAISE EXCEPTION 'remote worker artifact part requires an open or assembling upload' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_remote_worker_artifact_parts_sequence_guard ON remote_worker_artifact_parts;
      CREATE TRIGGER trg_remote_worker_artifact_parts_sequence_guard BEFORE INSERT ON remote_worker_artifact_parts
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_artifact_parts_sequence_guard();

      CREATE OR REPLACE FUNCTION gc_remote_worker_effect_transitions_chain_guard()
      RETURNS trigger AS $$
      DECLARE expected_sequence BIGINT; expected_previous TEXT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(
          NEW.registry_workspace_id || ':' || NEW.assignment_id || ':' || NEW.assignment_generation::text || ':' || NEW.intent_id, 507
        ));
        SELECT 1 + COALESCE(MAX(t.transition_sequence), 0),
               COALESCE((
                 SELECT g.transition_sha256 FROM remote_worker_effect_transitions g
                 WHERE g.registry_workspace_id = NEW.registry_workspace_id AND g.assignment_id = NEW.assignment_id
                   AND g.assignment_generation = NEW.assignment_generation AND g.intent_id = NEW.intent_id
                 ORDER BY g.transition_sequence DESC LIMIT 1
               ), '${zero}')
          INTO expected_sequence, expected_previous
          FROM remote_worker_effect_transitions t
          WHERE t.registry_workspace_id = NEW.registry_workspace_id AND t.assignment_id = NEW.assignment_id
            AND t.assignment_generation = NEW.assignment_generation AND t.intent_id = NEW.intent_id;
        IF NEW.transition_sequence <> expected_sequence OR NEW.previous_transition_sha256 <> expected_previous THEN
          RAISE EXCEPTION 'remote worker effect transition chain is out of order or misbound' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_remote_worker_effect_transitions_chain_guard ON remote_worker_effect_transitions;
      CREATE TRIGGER trg_remote_worker_effect_transitions_chain_guard BEFORE INSERT ON remote_worker_effect_transitions
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_effect_transitions_chain_guard();

      CREATE OR REPLACE FUNCTION gc_remote_worker_artifact_uploads_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.registry_workspace_id IS DISTINCT FROM OLD.registry_workspace_id
          OR NEW.execution_workspace_id IS DISTINCT FROM OLD.execution_workspace_id
          OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
          OR NEW.assignment_generation IS DISTINCT FROM OLD.assignment_generation
          OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
          OR NEW.worker_generation IS DISTINCT FROM OLD.worker_generation
          OR NEW.runtime_manifest_sha256 IS DISTINCT FROM OLD.runtime_manifest_sha256
          OR NEW.workspace_ceiling_sha256 IS DISTINCT FROM OLD.workspace_ceiling_sha256
          OR NEW.capability_ceiling_sha256 IS DISTINCT FROM OLD.capability_ceiling_sha256
          OR NEW.assignment_manifest_sha256 IS DISTINCT FROM OLD.assignment_manifest_sha256
          OR NEW.upload_id IS DISTINCT FROM OLD.upload_id
          OR NEW.upload_attempt IS DISTINCT FROM OLD.upload_attempt
          OR NEW.max_artifact_bytes IS DISTINCT FROM OLD.max_artifact_bytes
          OR NEW.staging_root_sha256 IS DISTINCT FROM OLD.staging_root_sha256
          OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
          OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
          OR NEW.created_at IS DISTINCT FROM OLD.created_at
          OR (OLD.committed_manifest_sha256 IS NOT NULL AND NEW.committed_manifest_sha256 IS DISTINCT FROM OLD.committed_manifest_sha256) THEN
          RAISE EXCEPTION 'remote worker artifact upload immutable bindings cannot change' USING ERRCODE = '23514';
        END IF;
        IF NEW.upload_revision < OLD.upload_revision
          OR NEW.verification_gate_revision < OLD.verification_gate_revision
          OR NEW.cleanup_revision < OLD.cleanup_revision
          OR (NEW.upload_state IS DISTINCT FROM OLD.upload_state AND NEW.upload_revision <> OLD.upload_revision + 1)
          OR (NEW.upload_state = OLD.upload_state AND NEW.upload_revision <> OLD.upload_revision)
          OR (NEW.cleanup_state IS DISTINCT FROM OLD.cleanup_state AND NEW.cleanup_revision <> OLD.cleanup_revision + 1)
          OR (NEW.cleanup_state = OLD.cleanup_state AND NEW.cleanup_revision <> OLD.cleanup_revision)
          OR (COALESCE(NEW.verification_gate_state, '') <> COALESCE(OLD.verification_gate_state, '')
              AND OLD.verification_gate_state IS NOT NULL AND NEW.verification_gate_revision <> OLD.verification_gate_revision + 1)
          OR (OLD.upload_state IN ('committed', 'abandoned', 'quarantined') AND NEW.upload_state IS DISTINCT FROM OLD.upload_state) THEN
          RAISE EXCEPTION 'remote worker artifact upload revision must advance monotonically by one on transition' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_remote_worker_artifact_uploads_guard ON remote_worker_artifact_uploads;
      CREATE TRIGGER trg_remote_worker_artifact_uploads_guard BEFORE UPDATE ON remote_worker_artifact_uploads
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_artifact_uploads_guard();

      CREATE OR REPLACE FUNCTION gc_reject_remote_worker_artifact_uploads_delete()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'remote worker artifact upload cannot be deleted' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_remote_worker_artifact_uploads_no_delete ON remote_worker_artifact_uploads;
      CREATE TRIGGER trg_remote_worker_artifact_uploads_no_delete BEFORE DELETE ON remote_worker_artifact_uploads
        FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_artifact_uploads_delete();

      CREATE OR REPLACE FUNCTION gc_remote_worker_artifact_verifications_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.registry_workspace_id IS DISTINCT FROM OLD.registry_workspace_id
          OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
          OR NEW.assignment_generation IS DISTINCT FROM OLD.assignment_generation
          OR NEW.manifest_id IS DISTINCT FROM OLD.manifest_id
          OR NEW.verification_id IS DISTINCT FROM OLD.verification_id
          OR NEW.kind IS DISTINCT FROM OLD.kind
          OR NEW.attempt_index IS DISTINCT FROM OLD.attempt_index
          OR NEW.assignment_manifest_sha256 IS DISTINCT FROM OLD.assignment_manifest_sha256
          OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
          OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'remote worker verification immutable bindings cannot change' USING ERRCODE = '23514';
        END IF;
        IF NEW.attempt_revision < OLD.attempt_revision
          OR (NEW.attempt_state IS DISTINCT FROM OLD.attempt_state AND NEW.attempt_revision <> OLD.attempt_revision + 1)
          OR (NEW.attempt_state = OLD.attempt_state AND NEW.attempt_revision <> OLD.attempt_revision)
          OR (OLD.attempt_state IN ('worker_reported', 'passed', 'failed', 'indeterminate', 'blocked') AND NEW.attempt_state IS DISTINCT FROM OLD.attempt_state) THEN
          RAISE EXCEPTION 'remote worker verification attempt revision must advance monotonically by one on transition' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_remote_worker_artifact_verifications_guard ON remote_worker_artifact_verifications;
      CREATE TRIGGER trg_remote_worker_artifact_verifications_guard BEFORE UPDATE ON remote_worker_artifact_verifications
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_artifact_verifications_guard();

      CREATE OR REPLACE FUNCTION gc_reject_remote_worker_artifact_verifications_delete()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'remote worker verification attempt cannot be deleted' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_remote_worker_artifact_verifications_no_delete ON remote_worker_artifact_verifications;
      CREATE TRIGGER trg_remote_worker_artifact_verifications_no_delete BEFORE DELETE ON remote_worker_artifact_verifications
        FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_artifact_verifications_delete();

      CREATE OR REPLACE FUNCTION gc_remote_worker_effect_receipts_guard()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.registry_workspace_id IS DISTINCT FROM OLD.registry_workspace_id
          OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
          OR NEW.assignment_generation IS DISTINCT FROM OLD.assignment_generation
          OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
          OR NEW.assignment_manifest_sha256 IS DISTINCT FROM OLD.assignment_manifest_sha256
          OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'remote worker effect receipt immutable bindings cannot change' USING ERRCODE = '23514';
        END IF;
        IF NEW.receipt_revision <> OLD.receipt_revision + 1
          OR OLD.receipt_state <> 'manual_reconciliation'
          OR NEW.receipt_state = 'manual_reconciliation'
          OR NEW.reconciliation_record_sha256 IS NULL THEN
          RAISE EXCEPTION 'remote worker effect receipt may only advance from manual reconciliation with an operator record' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_remote_worker_effect_receipts_guard ON remote_worker_effect_receipts;
      CREATE TRIGGER trg_remote_worker_effect_receipts_guard BEFORE UPDATE ON remote_worker_effect_receipts
        FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_effect_receipts_guard();

      CREATE OR REPLACE FUNCTION gc_reject_remote_worker_effect_receipts_delete()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'remote worker effect receipt cannot be deleted' USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_remote_worker_effect_receipts_no_delete ON remote_worker_effect_receipts;
      CREATE TRIGGER trg_remote_worker_effect_receipts_no_delete BEFORE DELETE ON remote_worker_effect_receipts
        FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_effect_receipts_delete();
  `;
}
