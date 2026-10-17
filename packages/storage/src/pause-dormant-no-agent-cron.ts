/**
 * One-time pause of no_agent cron jobs that were enabled but never ran while
 * no_agent execution sat behind GOATCITADEL_EXPERIMENTAL_NO_AGENT_CRON. After
 * graduation they would otherwise run their host command on the first scheduler
 * tick with no operator re-confirmation. Jobs that already ran keep their state.
 * The revision bump keeps compare-and-set writers from overwriting the pause.
 * Forward-only: a future change must use another migration; do not edit this one.
 */
export const PAUSE_DORMANT_NO_AGENT_CRON_JOBS_SQLITE_SQL = `UPDATE cron_jobs
SET enabled = 0,
    revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE action = 'no_agent'
  AND enabled <> 0
  AND last_run_at IS NULL
  AND last_run_id IS NULL;`;

export const PAUSE_DORMANT_NO_AGENT_CRON_JOBS_POSTGRES_SQL = `UPDATE cron_jobs
SET enabled = 0,
    revision = revision + 1,
    updated_at = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
WHERE action = 'no_agent'
  AND enabled <> 0
  AND last_run_at IS NULL
  AND last_run_id IS NULL;`;
