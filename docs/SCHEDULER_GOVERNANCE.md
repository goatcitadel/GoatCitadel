# Scheduler Governance

Last updated: 2026-07-05

GoatCitadel's cron scheduler is a first-class, governed automation surface: recurring
agent turns run under a restricted permission profile, model-created schedules are
capped and recursion-blocked, failures land in a human review queue, and every run
can emit a signed evidence envelope.

## Surfaces

| Surface | What it does |
| --- | --- |
| Mission Control → Ops → Schedules | List jobs, create schedules, review queue, last-run status + evidence id |
| `schedule.manage` tool | Model-callable create/list/cancel for `agent_turn` schedules |
| REST (`/api/v1/cron/*`, dashboard timeline) | CRUD, manual run (`force`), run snapshots |

## Guardrails (always on)

These are enforced in `apps/gateway/src/services/gateway/schedule-tool-support.ts`
and `cron-agent-turn-support.ts`; they are not feature-flagged:

- **Restricted execution profile.** Scheduled agent turns run under the dedicated
  scheduled-turn permission profile, not the interactive operator profile.
- **Per-creator cap.** A creator may own at most **25 enabled** `agent_turn` jobs
  (`MAX_AGENT_TURN_JOBS_PER_CREATOR`).
- **Interval floor.** Schedules finer than **15 minutes** are refused
  (`MIN_SCHEDULE_INTERVAL_MINUTES`).
- **Recursion blocked.** A scheduled turn cannot create further schedules
  (`MAX_SCHEDULE_CHAIN_DEPTH = 1`); only interactive turns can create scheduled work.
- **Failure backoff.** Failing jobs back off exponentially (1 minute base, 1 hour cap)
  and system jobs cannot be deleted.
- **Channel delivery.** `agent_turn` jobs may declare a `deliveryChannel`
  (`{ channelKey, target }`) so run output is delivered through the normal governed
  channel send path — the same policy gates as any other outbound send.

## Review queue (`cronReviewQueueV1Enabled`)

When enabled, run warnings, watchdog findings, and manual/forced runs are recorded
as review items with severity and resolution state, surfaced on the Schedules route.

## Signed run evidence (`cronEvidenceV1Enabled`)

When enabled, every cron run — success or failure, every action kind including
`agent_turn` and `no_agent` — records a `cron_job_executed` evidence envelope via
the standard evidence chain (`evidence-envelope-service`): HMAC-signed, hash-chained
to the previous envelope, offline-verifiable.

- Envelope metadata carries `jobId`, `jobName`, `action`, `schedule`, `status`, a
  SHA-256 `outputHash` of the run summary (the output itself is never embedded, so
  secrets in run output stay out of the evidence chain), and `failureMessage` on
  failures.
- The envelope id is pinned on the job record (`lastRunEvidenceEnvelopeId`) and on
  run snapshots (`CronRunSnapshot.evidenceEnvelopeId`), and shown on the Schedules
  route.
- Envelope recording is best-effort by construction: an evidence failure is logged
  as a diagnostic and never fails the run.

**Retention model:** the job record keeps only the *latest* run pointer; the
append-only envelope chain itself is the durable per-run history. To audit past
runs, query the evidence envelope store by `runId` or list envelopes with
`eventKind = "cron_job_executed"`.

## Related docs

- [CITADELS_OPERATING_MODEL.md](./CITADELS_OPERATING_MODEL.md) — scope and policy model
- [COMMUNICATION_CHANNEL_SETUP_GUIDE.md](./COMMUNICATION_CHANNEL_SETUP_GUIDE.md) — configuring delivery channels
