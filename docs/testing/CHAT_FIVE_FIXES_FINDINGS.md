# Five Chat fixes: findings and acceptance

Updated September 19, 2026 (Pacific). This records the five Chat fixes and their local isolated proof. Verification here is not CI, release, or deployment proof.

All five implementations pass their isolated acceptance checks. Live Deny/Stop/delegation acceptance remains open because Chrome control is unavailable; it is not recorded as a pass.

| Finding | Confirmed correction | Acceptance |
| --- | --- | --- |
| 1. Unrequested files | Removed synthetic document/presentation fallback. Prose, existing-file inspection, and no-file constraints do not trigger creation; explicit file requests get one persisted retry through the normal governed model loop. Success requires executed artifact evidence. | Focused intent/runner tests pass, including PDF/DOCX, retry, denial, failure, and unrelated-history cases. Actual PDF/DOCX tool tests pass. Original web prompt passed in user Chrome with one browser call and no artifact request. |
| 2. Deny renewed tool use | Canonical denial closes the parent turn and its delegated children, withdraws other pending approvals, and blocks dispatch and approval execution. Finalization uses recorded outcomes and suppresses further model/capability suggestions. | SQLite reopen, duplicate/late decisions, alternative-tool and dispatch-race tests pass. Desktop and narrow browser Deny pass, with no provider redispatch or replacement approval. |
| 3. Stop lost state/output | Gateway cancellation captures the safe buffered tail before abort, fences execution, withdraws requests, and saves partial output once. Branch selection retains the stopped turn without overriding a newer selection. UI waits for confirmation and rejects stale events. | Persistence/diagnostic failure, stream identity, SQLite recovery, and PostgreSQL tests pass. Desktop/narrow Stop passes before text, during streaming, and at a pending approval; saved output and stopped state survive reload. |
| 4. False health warning | Footer readiness follows `gatewayReady`; operational warnings remain separate. | Readiness-versus-wording UI tests pass. Healthy footer observed in user Chrome. |
| 5. Spurious delegation | Removed UI transcript launch and post-answer proactive trigger. Gateway persists an exact plan for durable confirmation, supports one specialist, and preserves auto/off governance and admitted capabilities. | Direct-path, exact-plan/reopen, capability inheritance, manual single-specialist and governed fan-out tests pass. Desktop/narrow browser confirmation runs the stored single-specialist plan once, visibly completes, and survives reload without relaunch. |

Additional confirmed regressions: denied-turn trace projection lost its closure marker; Stop did not advance the selected branch; sealed input responses incorrectly changed placement identity; inherited child-session grants were rejected by ID comparison; a durable parent could occupy the worker while waiting on its queued child; confirmed waits lacked recovery evidence and an atomic trace/wake transition; refresh coalescing discarded thread invalidations and replayed an irrelevant event during fallback. The fixes retain canonical admission, live grant checks, durable child watchers, and canonical transcript refreshes. Capability inspection now rejects mismatched session/turn selections; a fresh browser run has no console errors. Stopped turns no longer show a stale approval-wait badge.

An intermittent ignored Send was observed in an earlier isolated run. The composer callback now updates before paint. Subsequent desktop/narrow runs, including the final passing run, did not reproduce it; the earlier observation alone does not establish its cause.

Passing named isolated runs:

- Desktop and narrow browser acceptance: `artifacts/verification/2026-09-20T03-33-00-358Z-accessibility-smoke-7beb06ef` (both passed; functional assertions, accessibility, focus, overflow, and console checks).
- Runtime truth: `artifacts/verification/2026-09-20T03-35-38-362Z-runtime-truth-69661a20` (approval restart/resume and canonical shell; both scenarios passed).
- Durable recovery: `artifacts/verification/2026-09-20T03-37-11-525Z-durable-recovery-6b0ecce6` (restart, worker, and approval-wake scenarios all passed).
- Gateway async-boundary check passed (1,095 production files). Gateway, storage, shared/core UI, and canonical UI typechecks passed.
- Isolated PostgreSQL: six Gateway recovery tests plus four current/legacy SQLite and PostgreSQL continuation tests passed. The owned database stopped. The first attempt was interrupted by a Windows control signal before testing; it is not product-failure evidence.
- Final `git diff --check` passed. No task-owned verification processes remain. Pre-existing UI, Gateway, and PostgreSQL listeners remain running.

Harness corrections are distinct from product failures: explicitly answer the fixture's read approval; open collapsed tool evidence; use a provider frame within the secret projector's size boundary; observe cancellation confirmation before scrolling; opt the visual fixture into blocking prompts; supply revision and idempotency bindings for fixture mutations.

Live limitation: the original web prompt was verified in the existing Chrome tab. Subsequent Chrome control timed out, including a fresh tab attempt; live Deny/Stop/delegation acceptance remains pending until that connection is available. No operator services were restarted. Tests use disposable resources; GOATBOX, installed services, keys, disks, operator databases/settings, and unrelated work remain outside this change.

Repository-wide documentation checking is blocked by existing empty catches in remote-worker installation-capacity and installation-session files. Those unrelated files were left unchanged.

Automatic approval review rejected removal of the already-stopped disposable database directory `gc-chat-five-fixes-pg-h6zOP1` without a detailed reason. The directory remains as test evidence; its process and port are gone.
