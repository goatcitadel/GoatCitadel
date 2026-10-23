/**
 * Operator wording for runtime authority codes that carry no counts (SY-N06). Each sentence says what the record
 * shows in GoatCitadel's own words; the server's prose, owner and source stay in technical details.
 */
export const AUTHORITY_SENTENCES: Readonly<Record<string, string>> = {
  approvals_unavailable: "Approval decisions and their follow-on work can't be read right now.",
  approvals_malformed: "Some approval records are damaged, so no decision is shown for them.",
  approvals_some_malformed: "Some approval records are damaged and are left out below.",
  approvals_empty: "No approval decisions are recorded in this workspace's recent window.",
  runs_unavailable: "Runs can't be read right now.",
  runs_malformed: "Some run records are damaged, so no run state is shown for them.",
  runs_some_malformed: "Some run records are damaged and are left out below.",
  runs_window_incomplete: "The recent run window ended early, so some runs in this workspace may not be listed.",
  runs_empty: "No runs are recorded in this workspace's recent window.",
  run_signal: "A recorded event mentions this run. The run's own record decides its status.",
  run_signals_unavailable: "Recorded run events can't be read. Run status is unaffected.",
  run_status_unknown: "This run's status isn't one GoatCitadel recognises.",
  durable_workers_unavailable: "Worker leases can't be read, so worker health is unknown.",
  durable_workers_malformed: "Some worker lease records are damaged, so worker health isn't shown for them.",
  durable_workers_window_incomplete:
    "The running-run window ended early, so GoatCitadel can't confirm no worker is busy.",
  durable_workers_some_malformed: "Some worker lease records are damaged and are left out below.",
  durable_workers_more_beyond_window: "More running runs may exist beyond the ones checked here.",
  durable_worker_idle: "No running run in this workspace needs a worker right now.",
  worker_lease_expired: "This run's worker lease is missing or has expired.",
  worker_heartbeat_stale: "This run's worker lease is live, but its heartbeat is late or missing.",
  worker_lease_current: "This run's worker lease and heartbeat are current.",
  mesh_workers_unavailable: "Mesh nodes and their leases can't be read right now.",
  mesh_workers_window_incomplete: "Too many mesh records to read at once, so node and lease totals are incomplete.",
  mesh_workers_malformed: "Some mesh node or lease records are damaged and aren't counted.",
  mesh_workers_empty: "No mesh node has checked in and no mesh lease is held.",
  local_runtime_unavailable: "The local runtime's process and lease health can't be read right now.",
  backup_none_published: "No backup has been published yet.",
  backup_unreadable: "The latest backup can't be read right now.",
  backup_malformed: "The latest backup says it verified, but it has no valid creation time, so it isn't trusted.",
  backup_verified: "The latest backup's manifest and files verified.",
  backup_verified_stale: "The latest backup verified, but it's old.",
  release_verified: "The release certificate matches this build and its required checks.",
  release_unverified: "A release certificate exists, but it doesn't match this build or its checks.",
  release_certificate_malformed: "The release certificate is damaged, so this release isn't verified.",
  release_metadata_incomplete:
    "The release certificate is missing some of its details, so this release isn't verified.",
  release_certificate_missing: "No release certificate is available to this installation.",
  build_modified: "This installation is running with local changes to its source.",
  build_clean: "This installation is running an unmodified build.",
  build_integrity_unknown: "GoatCitadel can't tell whether this build has local changes.",
  running_build_identity_unavailable: "GoatCitadel can't identify the build it's running.",
  config_generation_unavailable: "The active configuration version can't be read right now.",
  config_reconciliation_clear: "Every runtime part is using the current configuration.",
  config_recovery_not_needed: "Startup didn't need to recover the configuration.",
  config_recovery_not_checked: "Startup recovery hasn't been checked yet.",
  config_recovery_no_config: "There was no saved configuration for startup to recover.",
  manual_reconciliation_unavailable: "Outside actions that may need checking can't be read for this workspace.",
  manual_reconciliation_window_incomplete:
    "Too many outside actions to read at once, so an older one needing a check may be missing.",
  manual_reconciliation_malformed: "Some recent outside-action records are damaged and aren't shown.",
  manual_reconciliation_clear: "No outside action in this workspace's recent window needs checking.",
  manual_reconciliation:
    "An outside service's result is unknown. Check it in the service itself, then record the outcome.",
  manual_reconciliation_some_malformed: "Some recent outside-action records are damaged and are left out below.",
  manual_reconciliation_more_beyond_window:
    "Known outside actions needing a check are shown; older ones may be missing.",
};

/** A heading per record kind. Per-record runs, approvals and workers keep their own names. */
export const AUTHORITY_HEADINGS: Readonly<Record<string, string>> = {
  approvals: "Approvals",
  runs: "Runs",
  run_signal: "Recorded run event",
  run_signals: "Recorded run events",
  durable_workers: "Workers",
  durable_worker: "Workers",
  worker: "Worker lease",
  worker_leases: "Workers",
  mesh_workers: "Mesh nodes",
  local_runtime: "Local runtime",
  backup: "Latest backup",
  release: "Release certificate",
  build: "Running build",
  running_build_identity: "Running build",
  config_generation: "Configuration version",
  config_reconciliation: "Configuration in use",
  config_recovered: "Configuration recovery",
  config_recovery: "Configuration recovery",
  manual_reconciliation: "Outside actions to check",
  approval_records: "Approvals",
};

const RUN_STATUS: Readonly<Record<string, string>> = {
  queued: "is queued",
  running: "is running",
  waiting: "is waiting",
  paused: "is paused",
  completed: "finished",
  failed: "failed",
  cancelled: "was cancelled",
  dead_lettered: "stopped after repeated failures",
};

const APPROVAL_DECISION: Readonly<Record<string, string>> = {
  pending: "Waiting for a decision",
  approved: "Approved",
  rejected: "Denied",
  edited: "Approved with edits",
  decided: "Decided",
};

const APPROVAL_SETTLEMENT: Readonly<Record<string, string>> = {
  effects_unavailable: "what happened next can't be read",
  awaiting_decision: "nothing has happened yet",
  effects_manual: "a follow-on action needs checking by hand",
  effects_failed: "a follow-on action failed",
  effects_pending: "follow-on actions are still finishing",
  no_effects: "no follow-on action was recorded",
  effects_settled: "every follow-on action finished",
};

/** Codes that carry their own part of the sentence: run_<status> and approval_<decision>_<settlement>. */
export function presentPatternedCode(code: string): string | undefined {
  if (code.startsWith("run_") && RUN_STATUS[code.slice(4)]) return `This run ${RUN_STATUS[code.slice(4)]}.`;
  const approval = /^approval_(pending|approved|rejected|edited|decided)_([a-z_]+)$/u.exec(code);
  if (approval && APPROVAL_SETTLEMENT[approval[2]!]) {
    // A pending decision has nothing after it, so the settlement part would only repeat that.
    if (approval[1] === "pending") return "Waiting for a decision.";
    return `${APPROVAL_DECISION[approval[1]!]}; ${APPROVAL_SETTLEMENT[approval[2]!]}.`;
  }
  return undefined;
}

/** The heading for a code: the longest known prefix, so "backup_verified_stale" reads "Latest backup". */
export function headingForCode(code: string): string | undefined {
  const parts = code.split("_");
  for (let length = parts.length; length > 0; length -= 1) {
    const heading = AUTHORITY_HEADINGS[parts.slice(0, length).join("_")];
    if (heading) return heading;
  }
  return undefined;
}
